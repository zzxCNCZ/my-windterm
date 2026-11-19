const MAX_COMMAND_LENGTH = 4096;

export function commandText(value) {
  const text = value.trim();
  return text && text.length <= MAX_COMMAND_LENGTH && !/[\u0000-\u001f\u007f-\u009f]/u.test(text) ? text : null;
}

export function echoedCommand(line) {
  const match = /^(?:(?:\[[^\]\r\n]*@[^\]\r\n]+\]|[\w.-]+@[\w.:-]+).*?[#$%]|[\w.-]+(?:\s[^$#%]*)?[$%]|(?:bash|sh)-[\d.]+#)\s+(.+)$/u.exec(line);
  if (match) return commandText(match[1]);
  const generic = /^(?!\s*(?:password|passphrase|verification code|enter\s)\b).{0,512}?[#$%>❯➜λ❱›]\s+(.+)$/iu.exec(line);
  return generic ? commandText(generic[1]) : null;
}

export function makeOutline(term, isReady, changed) {
  const entries = [];
  let promptEnd = null, explicit = null, recorded = false, pending = [], typed = '', highlight;
  function endInput() {
    pending = [];
    typed = '';
  }
  function clear() {
    highlight?.dispose();
    highlight = undefined;
    const previous = entries.splice(0);
    for (const entry of previous) entry.marker.dispose();
    changed();
  }
  function reset() {
    promptEnd = explicit = null;
    recorded = false;
    endInput();
    clear();
  }
  function capture(text, line) {
    if (!text || !isReady() || term.buffer.active.type !== 'normal') return;
    const buffer = term.buffer.active;
    const marker = term.registerMarker(line - buffer.baseY - buffer.cursorY);
    if (!marker || marker.isDisposed) return;
    const entry = { text, marker };
    entries.push(entry);
    marker.onDispose(() => {
      const index = entries.indexOf(entry);
      if (index >= 0) {
        entries.splice(index, 1);
        changed();
      }
    });
    if (entries.length > 600) entries[0].marker.dispose();
    changed();
  }
  function collect(start, end) {
    const buffer = term.buffer.active;
    if (start.line > end.line || end.line - start.line > 40) return null;
    const lines = [];
    for (let index = start.line; index <= end.line; index++) {
      const row = buffer.getLine(index);
      if (!row) return null;
      const text = row.translateToString(index === end.line || !buffer.getLine(index + 1)?.isWrapped, index === start.line ? start.column : 0,
        index === end.line ? end.column : undefined);
      if (!row.isWrapped && lines.length && text) lines.push(' ');
      lines.push(text);
    }
    return commandText(lines.join(''));
  }
  function position() {
    const buffer = term.buffer.active;
    return { line: buffer.baseY + buffer.cursorY, column: buffer.cursorX };
  }
  function osc(code, payload) {
    if (term.buffer.active.type !== 'normal') return false;
    if (payload === 'A') {
      promptEnd = explicit = null;
      recorded = false;
    } else if (payload === 'B') {
      promptEnd = position();
      recorded = false;
    } else if (code === 633 && payload.startsWith('E;') && payload.length <= MAX_COMMAND_LENGTH * 4 + 256) {
      explicit = commandText(payload.slice(2).split(';', 1)[0].replace(/\\x([\da-f]{2})|\\\\/gi,
        (match, hex) => hex ? String.fromCharCode(Number.parseInt(hex, 16)) : '\\'));
    } else if (payload === 'C') {
      const end = position();
      const text = explicit ?? (promptEnd && collect(promptEnd, end));
      if (text && !recorded) {
        pending.shift();
        capture(text, promptEnd?.line ?? end.line);
      }
      explicit = promptEnd = null;
      recorded = false;
    } else return false;
    return true;
  }
  for (const code of [133, 633]) term.parser.registerOscHandler(code, payload => osc(code, payload));
  function lineFeed() {
    if (!pending.length || !isReady() || term.buffer.active.type !== 'normal') return;
    const buffer = term.buffer.active;
    const end = position();
    const last = end.line - 1;
    if (last < 0) return;
    let first = last;
    while (first > 0 && last - first < 40 && buffer.getLine(first)?.isWrapped) first--;
    const line = collect({ line: first, column: 0 }, { line: last });
    const submitted = pending.shift();
    if (!line) return;
    if (promptEnd && !recorded && promptEnd.line <= last) {
      const marked = collect(promptEnd, { line: last });
      if (marked && (submitted === null || marked === submitted)) {
        capture(marked, promptEnd.line);
        recorded = true;
        return;
      }
    }
    const echoed = echoedCommand(line);
    if (submitted && line.endsWith(submitted)) {
      capture(submitted, first);
    } else if (echoed && !submitted) {
      capture(echoed, first);
    }
  }
  term.onLineFeed(lineFeed);
  function input(data) {
    if (!isReady() || term.buffer.active.type !== 'normal') {
      endInput();
      return;
    }
    if (/^\x1b(?!\[200~)/u.test(data)) { typed = null; return; }
    for (const character of data.replace(/\x1b\[(?:200|201)~/gu, '').replace(/\r\n/gu, '\r')) {
      if (character === '\r' || character === '\n') {
        const text = typed === null ? null : commandText(typed);
        if ((text || typed === null) && pending.length < 64) pending.push(text);
        typed = '';
      } else if (character === '\x03') {
        endInput();
      } else if (character === '\x15') {
        typed = '';
      } else if (character === '\x08' || character === '\x7f') {
        if (typed !== null) typed = Array.from(typed).slice(0, -1).join('');
      } else if (typed !== null) {
        typed = !/[\u0000-\u001f\u007f-\u009f]/u.test(character) && typed.length < MAX_COMMAND_LENGTH
          ? typed + character : null;
      }
    }
  }
  return {
    entries, clear, reset, input, endInput,
    jump(entry) {
      if (entry.marker.isDisposed || term.buffer.active.type !== 'normal' || entry.marker.line < 0) return false;
      term.scrollToLine(entry.marker.line - Math.floor(term.rows / 3));
      highlight?.dispose();
      highlight = term.registerDecoration({ marker: entry.marker, width: term.cols, backgroundColor: '#293d53' });
      return true;
    },
  };
}
