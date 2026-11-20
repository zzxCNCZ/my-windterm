use reqwest::Response;
use serde_json::{Value, json};
use std::collections::BTreeMap;

use super::{MAX_RESPONSE, MAX_SEARCHES};

const INVALID: &str = "AI 返回了不兼容的流式回复。";
const INTERRUPTED: &str = "AI 回复中断。";

pub(super) enum Delta<'a> {
    Answer(&'a str),
    Reasoning(&'a str),
}

#[derive(Default)]
pub(super) struct Reply {
    pub text: String,
    pub reasoning: String,
    pub calls: Vec<Value>,
}

impl Reply {
    fn add_text(&mut self, message: &Value, emit: &mut impl FnMut(Delta<'_>)) {
        if let Some(text) = message["reasoning_content"]
            .as_str()
            .or_else(|| message["reasoning"].as_str())
            .filter(|text| !text.is_empty())
        {
            self.reasoning.push_str(text);
            emit(Delta::Reasoning(text));
        }
        if let Some(text) = message["content"].as_str().filter(|text| !text.is_empty()) {
            self.text.push_str(text);
            emit(Delta::Answer(text));
        }
    }
}

#[derive(Default)]
struct Call {
    id: String,
    kind: String,
    name: String,
    arguments: String,
}

impl Call {
    fn add(&mut self, delta: &Value) -> Result<(), String> {
        if let Some(id) = delta["id"].as_str() {
            if !self.id.is_empty() && self.id != id {
                return Err(INVALID.into());
            }
            self.id = id.into();
        }
        if let Some(kind) = delta["type"].as_str() {
            self.kind = kind.into();
        }
        if let Some(name) = delta["function"]["name"].as_str() {
            self.name.push_str(name);
        }
        if let Some(arguments) = delta["function"]["arguments"].as_str() {
            self.arguments.push_str(arguments);
        }
        if self.id.len() > 256 || self.name.len() > 64 || self.arguments.len() > 8192 {
            return Err(INVALID.into());
        }
        Ok(())
    }

    fn into_value(self) -> Value {
        let kind = if self.kind.is_empty() {
            "function"
        } else {
            &self.kind
        };
        json!({"id": self.id, "type": kind, "function": {"name": self.name, "arguments": self.arguments}})
    }
}

#[derive(Default)]
struct Capture {
    reply: Reply,
    calls: BTreeMap<u64, Call>,
    finished: bool,
}

impl Capture {
    fn ingest(&mut self, frame: &[u8], emit: &mut impl FnMut(Delta<'_>)) -> Result<(), String> {
        if self.finished {
            return Ok(());
        }
        if frame.trim_ascii() == b"[DONE]" {
            self.finished = true;
            return Ok(());
        }
        let value: Value = serde_json::from_slice(frame).map_err(|_| INVALID)?;
        if value.get("error").is_some() {
            return Err(INTERRUPTED.into());
        }
        let choice = &value["choices"][0];
        let delta = &choice["delta"];
        self.reply.add_text(delta, emit);
        if let Some(calls) = delta["tool_calls"].as_array() {
            for call in calls {
                let index = call["index"]
                    .as_u64()
                    .filter(|index| *index < MAX_SEARCHES as u64)
                    .ok_or(INVALID)?;
                self.calls.entry(index).or_default().add(call)?;
            }
        }
        self.finished = choice["finish_reason"].is_string();
        Ok(())
    }

    fn finish(mut self) -> Result<Reply, String> {
        if !self.finished {
            return Err(INTERRUPTED.into());
        }
        self.reply.calls = self.calls.into_values().map(Call::into_value).collect();
        Ok(self.reply)
    }
}

#[derive(Default)]
struct Frames {
    pending: Vec<u8>,
    data: Vec<u8>,
}

impl Frames {
    fn push(
        &mut self,
        chunk: &[u8],
        mut emit: impl FnMut(&[u8]) -> Result<(), String>,
    ) -> Result<(), String> {
        self.pending.extend_from_slice(chunk);
        let mut end = 0;
        for line in self.pending.split_inclusive(|byte| *byte == b'\n') {
            let Some(line) = line.strip_suffix(b"\n") else {
                break;
            };
            Self::line(&mut self.data, line, &mut emit)?;
            end += line.len() + 1;
        }
        self.pending.drain(..end);
        Ok(())
    }

    fn finish(mut self, mut emit: impl FnMut(&[u8]) -> Result<(), String>) -> Result<(), String> {
        if !self.pending.is_empty() {
            Self::line(&mut self.data, &self.pending, &mut emit)?;
        }
        Self::line(&mut self.data, b"", &mut emit)
    }

    fn line(
        data: &mut Vec<u8>,
        line: &[u8],
        emit: &mut impl FnMut(&[u8]) -> Result<(), String>,
    ) -> Result<(), String> {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.is_empty() {
            if !data.is_empty() {
                emit(data)?;
                data.clear();
            }
        } else if let Some(value) = line.strip_prefix(b"data:") {
            if !data.is_empty() {
                data.push(b'\n');
            }
            data.extend_from_slice(value.strip_prefix(b" ").unwrap_or(value));
        }
        Ok(())
    }
}

pub(super) async fn read(
    mut response: Response,
    mut emit: impl FnMut(Delta<'_>),
) -> Result<Reply, String> {
    let is_sse = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(';')
                .next()
                .is_some_and(|kind| kind.trim().eq_ignore_ascii_case("text/event-stream"))
        });
    if !is_sse {
        let value = super::read_json(response, "AI").await?;
        let message = value
            .pointer("/choices/0/message")
            .filter(|value| value.is_object())
            .ok_or(INVALID)?;
        let mut reply = Reply::default();
        reply.add_text(message, &mut emit);
        reply.calls = message["tool_calls"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        return Ok(reply);
    }
    let mut capture = Capture::default();
    let mut frames = Frames::default();
    let mut bytes = 0;
    while let Some(chunk) = response.chunk().await.map_err(|_| INTERRUPTED)? {
        bytes += chunk.len();
        if bytes > MAX_RESPONSE {
            return Err("AI: response too large.".into());
        }
        frames.push(&chunk, |frame| capture.ingest(frame, &mut emit))?;
        if capture.finished {
            break;
        }
    }
    if !capture.finished {
        frames.finish(|frame| capture.ingest(frame, &mut emit))?;
    }
    capture.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_fragmented_utf8_sse_and_function_arguments() {
        let frames = [
            json!({"choices":[{"delta":{"reasoning_content":"先排查"}}]}),
            json!({"choices":[{"delta":{"content":"检查磁盘","tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"brave_search","arguments":"{\"query\":"}}]}}]}),
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"ENOSPC\"}"}}]},"finish_reason":"tool_calls"}]}),
        ];
        let wire: String = frames
            .iter()
            .map(|frame| format!("data: {frame}\r\n\r\n"))
            .collect();
        let mut capture = Capture::default();
        let mut decoder = Frames::default();
        let mut deltas = Vec::new();
        for byte in wire.bytes() {
            decoder
                .push(&[byte], |frame| {
                    capture.ingest(frame, &mut |delta| {
                        deltas.push(match delta {
                            Delta::Reasoning(text) => ("reasoning", text.to_owned()),
                            Delta::Answer(text) => ("answer", text.to_owned()),
                        });
                    })
                })
                .unwrap();
        }
        let reply = capture.finish().unwrap();
        assert_eq!(
            deltas,
            [
                ("reasoning", "先排查".into()),
                ("answer", "检查磁盘".into())
            ]
        );
        assert_eq!(
            reply.calls[0]["function"]["arguments"],
            "{\"query\":\"ENOSPC\"}"
        );
    }

    #[test]
    fn rejects_disconnect_without_terminal_marker() {
        let mut capture = Capture::default();
        capture
            .ingest(
                br#"{"choices":[{"delta":{"content":"partial"}}]}"#,
                &mut |_| {},
            )
            .unwrap();
        assert!(capture.finish().is_err());
    }
}
