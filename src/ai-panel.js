import { Channel } from '@tauri-apps/api/core';
import { t } from './i18n.js';
import { defaultContextLines } from './terminal-context.js';
import { renderAiMarkdown } from './ai-markdown.js';

const errorText = error => error instanceof Error ? error.message : String(error);

function node(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

const titleFor = question => question.replace(/\s+/g, ' ').slice(0, 70);

export function makeAiPanel({ root, invoke, showDock, newId }) {
  const find = id => root.querySelector(`#${id}`);
  const messages = find('ai-messages');
  const history = find('ai-history');
  const form = find('ai-form');
  const input = find('ai-input');
  const send = find('ai-send');
  const stop = find('ai-stop');
  const create = find('ai-new');
  const status = find('ai-status');
  const include = find('ai-include-context');
  const search = find('ai-use-search');
  const preview = find('ai-preview');
  const previewText = find('ai-preview-text');
  const previewToggle = find('ai-preview-toggle');
  const clear = find('ai-clear-selection');
  let terminal, liveReply;
  let streamFrame = 0;
  let contextLines = defaultContextLines;
  let searchReady = false;
  let atBottom = true;

  messages.addEventListener('scroll', () => {
    atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight <= 8;
  });
  new ResizeObserver(() => {
    if (atBottom) messages.scrollTop = messages.scrollHeight;
  }).observe(messages);

  const sessions = () => terminal?.aiSessions;
  const thread = () => sessions()?.current;

  function renderStatus() {
    const { message = '', error = false } = thread()?.status ?? {};
    status.hidden = !message;
    status.classList.toggle('ai-error', error);
    status.textContent = t(message);
  }

  function setStatus(conversation, message = '', error = false) {
    conversation.status = { message, error };
    if (conversation === thread()) renderStatus();
  }

  function openSource(conversation, url) {
    void invoke('open_ai_source', { url })
      .catch(error => { if (!conversation.disposed) setStatus(conversation, errorText(error), true); });
  }

  messages.addEventListener('click', event => {
    const link = event.target.closest('.ai-markdown-link');
    if (link && thread()) openSource(thread(), link.dataset.aiUrl);
  });

  function sourceButtons(sources, conversation = thread()) {
    const list = node('div', 'ai-sources');
    list.append(node('span', '', t('联网搜索结果')));
    for (const source of sources) {
      if (typeof source?.url !== 'string') continue;
      const link = node('button', 'ai-source', source.title || source.url);
      link.type = 'button';
      link.title = source.url;
      link.addEventListener('click', () => openSource(conversation, source.url));
      list.append(link);
    }
    return list;
  }

  function toolRecord(tool, conversation, open) {
    const record = node('details', 'ai-tool-record');
    record.open = open;
    const label = node('summary', 'ai-tool-summary');
    const name = tool.name === 'brave_search' ? 'Brave Search' : tool.name || t('工具调用');
    const states = { running: '正在执行', succeeded: '已完成', failed: '执行失败', stopped: '已停止' };
    label.append(node('span', '', name), node('span', `ai-tool-state ai-tool-${tool.state}`, t(states[tool.state])));
    record.append(label);
    if (tool.query) {
      const query = node('p', 'ai-tool-query');
      query.append(node('span', '', t('检索词')), node('code', '', tool.query));
      record.append(query);
    }
    if (tool.error) record.append(node('p', 'ai-tool-error', t(tool.error)));
    if (tool.state === 'succeeded') {
      if (tool.sources.length) record.append(sourceButtons(tool.sources, conversation));
      else record.append(node('p', '', t('未找到搜索结果。')));
    }
    return record;
  }

  function updateTrace(view, entries, stage) {
    const { details, summary, timeline, conversation } = view;
    const follow = stage && timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight <= 8;
    details.hidden = !entries.length;
    const hasTools = entries.some(entry => entry.kind === 'tool');
    const hasReasoning = entries.some(entry => entry.kind === 'reasoning');
    let label = hasTools && hasReasoning ? '思考与工具过程' : hasTools ? '工具执行过程' : '思考过程';
    if (stage === 'reasoningDelta') label = '正在思考…';
    if (entries.some(entry => entry.tool?.state === 'running')) label = '正在联网搜索…';
    const title = t(label);
    if (summary.textContent !== title) summary.textContent = title;
    for (const [index, entry] of entries.entries()) {
      if (view.entries[index] === entry) continue;
      const previous = timeline.children[index];
      let row;
      if (entry.kind === 'reasoning') {
        row = node('div', 'ai-markdown ai-trace-reasoning');
        row.innerHTML = renderAiMarkdown(entry.text);
      } else {
        row = toolRecord(entry.tool, conversation, previous?.open ?? false);
      }
      if (previous) previous.replaceWith(row);
      else timeline.append(row);
      view.entries[index] = entry;
    }
    if (follow) timeline.scrollTop = timeline.scrollHeight;
  }

  function message(role, text, result) {
    const article = node('article', `ai-message ai-message-${role}`);
    article.append(node('strong', '', t(role === 'user' ? '你' : 'AI')));
    if (role === 'user') {
      article.append(node('div', 'ai-message-text', text));
      return { article };
    }
    const body = node('div', 'ai-message-text ai-markdown');
    body.innerHTML = renderAiMarkdown(text);
    const details = node('details', 'ai-trace');
    const summary = node('summary', '', t('思考过程'));
    const timeline = node('div', 'ai-trace-timeline');
    details.append(summary, timeline);
    details.open = result.traceOpen ?? true;
    details.addEventListener('toggle', () => {
      result.traceOpen = details.open;
      if (details.isConnected && details.open && atBottom) messages.scrollTop = messages.scrollHeight;
    });
    const trace = { details, summary, timeline, entries: [], conversation: thread() };
    updateTrace(trace, result.trace, result.stage);
    article.append(details);
    article.append(body);
    return { article, body, text, trace };
  }

  function renderMessages(follow = true) {
    const scrollTop = messages.scrollTop;
    const conversation = thread();
    const running = conversation?.running;
    const content = [];
    for (const turn of conversation?.turns ?? []) {
      content.push(message('user', turn.question).article);
      const { article } = message('assistant', turn.answer, turn);
      if (Array.isArray(turn.sources) && turn.sources.length) article.append(sourceButtons(turn.sources));
      content.push(article);
    }
    liveReply = undefined;
    const pending = running || conversation?.interrupted;
    if (pending) {
      content.push(message('user', pending.question).article);
      const bubble = message('assistant', pending.text, pending);
      bubble.article.hidden = !pending.text && !pending.trace.length;
      content.push(bubble.article);
      if (running) liveReply = bubble;
    }
    if (!content.length) {
      content.push(node('p', 'ai-empty', t(conversation
        ? '选中终端片段后发送给 AI，或直接输入问题。'
        : '打开终端标签后开始 AI 问答。')));
    }
    messages.replaceChildren(...content);
    atBottom = follow;
    messages.scrollTop = follow ? messages.scrollHeight : scrollTop;
  }

  function renderStream(conversation, target) {
    if (conversation !== thread() || streamFrame) return;
    streamFrame = requestAnimationFrame(() => {
      streamFrame = 0;
      if (thread() !== conversation || conversation.running !== target || !liveReply) return;
      const { article, body, trace } = liveReply;
      article.hidden = !target.text && !target.trace.length;
      updateTrace(trace, target.trace, target.stage);
      if (liveReply.text !== target.text) {
        body.innerHTML = renderAiMarkdown(target.text);
        liveReply.text = target.text;
      }
      if (atBottom) messages.scrollTop = messages.scrollHeight;
    });
  }

  function renderHistory() {
    const items = [];
    const owner = sessions();
    for (const conversation of owner?.conversations ?? []) {
      const question = conversation.turns[0]?.question || conversation.running?.question;
      const title = question ? titleFor(question) : `${t('问答会话')} ${conversation.number}`;
      const row = node('div', 'ai-history-row');
      const select = node('button', 'ai-history-select', conversation.running ? `… ${title}` : title);
      select.type = 'button';
      select.title = title;
      select.setAttribute('aria-current', String(owner.current === conversation));
      select.addEventListener('click', () => {
        if (sessions() !== owner || conversation.disposed || owner.current === conversation) return;
        owner.current = conversation;
        render();
      });
      const remove = node('button', 'ai-history-remove', '×');
      remove.type = 'button';
      remove.title = t('删除问答会话');
      remove.setAttribute('aria-label', `${remove.title} ${title}`);
      remove.addEventListener('click', () => {
        if (sessions() !== owner || conversation.disposed) return;
        const wasCurrent = owner.current === conversation;
        discardConversation(conversation);
        owner.remove(conversation);
        if (wasCurrent) render();
        else renderHistory();
      });
      row.append(select, remove);
      items.push(row);
    }
    if (!items.length) items.push(node('p', 'ai-empty', t('请先打开终端标签。')));
    history.replaceChildren(...items);
  }

  function currentContext(conversation) {
    return conversation.pinned || terminal?.aiSelection() || terminal?.aiRecent(contextLines);
  }

  function renderPreview() {
    const context = thread()?.preview;
    preview.hidden = context === undefined;
    previewToggle.setAttribute('aria-expanded', String(!preview.hidden));
    previewText.textContent = preview.hidden ? '' : !context?.text ? t('当前终端暂无可附带的内容。')
      : context.truncated ? `${context.text}\n\n[${t('上下文已截取')}]` : context.text;
  }

  function renderControls() {
    const conversation = thread();
    const running = conversation?.running;
    const busy = Boolean(running);
    const unavailable = busy || !conversation;
    input.disabled = unavailable;
    send.disabled = unavailable;
    include.disabled = unavailable;
    include.checked = conversation?.includeContext ?? true;
    search.disabled = unavailable || !searchReady;
    search.checked = searchReady && Boolean(conversation?.webSearch);
    search.parentElement.title = t(searchReady ? '联网搜索公开资料' : '在偏好设置的 AI 工具中启用联网搜索');
    previewToggle.disabled = unavailable || !include.checked;
    previewToggle.title = conversation?.pinned ? t('预览所选终端片段') : `${t('预览最近终端输出')} · ${contextLines}`;
    clear.hidden = !conversation?.pinned;
    clear.disabled = unavailable;
    create.disabled = !conversation;
    stop.hidden = !busy;
    stop.disabled = Boolean(running?.stopping);
  }

  function render(follow) {
    if (streamFrame) cancelAnimationFrame(streamFrame);
    streamFrame = 0;
    input.value = thread()?.draft ?? '';
    renderMessages(follow);
    renderHistory();
    renderPreview();
    renderStatus();
    renderControls();
  }

  function focus(selection, owner = terminal) {
    if (owner !== terminal) return;
    showDock();
    const conversation = thread();
    if (!conversation || conversation.running) return;
    if (selection) {
      conversation.pinned = selection;
      conversation.includeContext = true;
      conversation.preview = undefined;
      renderPreview();
      renderControls();
    }
    input.focus();
  }

  create.addEventListener('click', () => {
    const owner = sessions();
    if (!owner) return;
    owner.create();
    render();
    input.focus();
  });
  clear.addEventListener('click', () => {
    const conversation = thread();
    if (!conversation) return;
    conversation.pinned = undefined;
    conversation.preview = undefined;
    renderPreview();
    renderControls();
  });
  include.addEventListener('change', () => {
    const conversation = thread();
    if (!conversation) return;
    conversation.includeContext = include.checked;
    conversation.preview = undefined;
    renderPreview();
    renderControls();
  });
  search.addEventListener('change', () => { if (thread()) thread().webSearch = search.checked; });
  previewToggle.addEventListener('click', () => {
    const conversation = thread();
    if (!conversation) return;
    conversation.preview = conversation.preview === undefined ? currentContext(conversation) ?? null : undefined;
    renderPreview();
  });

  input.addEventListener('input', () => { if (thread()) thread().draft = input.value; });
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    send.click();
  });
  async function stopRequest(conversation, target) {
    try {
      await invoke('stop_ai', { id: target.id });
    } catch (error) {
      if (!conversation.disposed && conversation.running === target) {
        target.stopping = false;
        setStatus(conversation, errorText(error), true);
        if (conversation === thread()) renderControls();
      }
    }
  }

  function cancel(conversation) {
    const target = conversation.running;
    if (!target || target.stopping) return;
    target.stopping = true;
    if (target.started) void stopRequest(conversation, target);
  }

  function discardConversation(conversation) {
    conversation.disposed = true;
    cancel(conversation);
    conversation.running = undefined;
    conversation.draft = '';
    conversation.pinned = undefined;
    conversation.preview = undefined;
    conversation.interrupted = undefined;
    conversation.turns.length = 0;
  }

  stop.addEventListener('click', () => {
    const conversation = thread();
    if (conversation) cancel(conversation);
    renderControls();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const owner = sessions();
    const conversation = owner?.current;
    const question = input.value.trim();
    if (!question || !conversation || conversation.running) return;
    const context = include.checked
      ? (conversation.preview === undefined ? currentContext(conversation) : conversation.preview)?.text
      : null;
    const target = { id: newId(), question, text: '', trace: [] };
    const request = {
      id: target.id, question, context: context || null, webSearch: searchReady && search.checked,
      history: conversation.turns.slice(-6).map(({ question, answer }) => ({ question, answer })),
    };
    conversation.draft = input.value;
    conversation.interrupted = undefined;
    conversation.running = target;
    conversation.preview = undefined;
    setStatus(conversation, '正在等待 AI 回复…');
    render();
    const progress = new Channel(({ kind, text, tool }) => {
      if (!target.started) {
        target.started = true;
        if (target.stopping) void stopRequest(conversation, target);
      }
      if (conversation.disposed || conversation.running !== target || target.stopping) return;
      if (kind === 'thinking') target.text = '';
      if (kind === 'reasoningDelta') {
        const last = target.trace.at(-1);
        if (last?.kind === 'reasoning') target.trace[target.trace.length - 1] = { kind: 'reasoning', text: last.text + text };
        else target.trace.push({ kind: 'reasoning', text });
      }
      if (kind === 'answerDelta') target.text += text;
      const stage = kind === 'toolUpdate' ? (tool.state === 'running' ? 'searching' : 'thinking') : kind;
      if (kind === 'toolUpdate') {
        const entry = { kind: 'tool', tool };
        const index = target.trace.findIndex(value => value.tool?.id === tool.id);
        if (index === -1) target.trace.push(entry);
        else target.trace[index] = entry;
      }
      if (stage !== target.stage) {
        const labels = { thinking: '正在等待 AI 回复…', searching: '正在联网搜索…',
          reasoningDelta: '正在思考…', answerDelta: '正在输出回答…' };
        setStatus(conversation, labels[stage]);
        target.stage = stage;
      }
      renderStream(conversation, target);
    });
    try {
      const answer = await invoke('ask_ai', { request, progress });
      if (conversation.disposed) return;
      const turn = { question, answer: answer.text, trace: answer.trace, traceOpen: target.traceOpen, sources: answer.sources };
      conversation.turns.push(turn);
      conversation.draft = '';
      conversation.pinned = undefined;
      setStatus(conversation);
    } catch (error) {
      if (conversation.disposed) return;
      const detail = errorText(error);
      const stopped = detail === 'AI 问答已停止。';
      target.trace = target.trace.map(entry => entry.tool?.state === 'running'
        ? { ...entry, tool: { ...entry.tool, state: stopped ? 'stopped' : 'failed' } }
        : entry);
      target.stage = undefined;
      if (target.text || target.trace.length) conversation.interrupted = target;
      setStatus(conversation, detail, !stopped);
    } finally {
      conversation.running = undefined;
      if (!conversation.disposed && thread() === conversation) {
        render(atBottom);
        if (!root.classList.contains('collapsed') && document.activeElement === document.body) input.focus();
      } else if (sessions() === owner) {
        renderHistory();
      }
    }
  });

  return {
    focus,
    setTerminal(next) {
      if (next === terminal) return;
      terminal = next;
      render();
    },
    closeTerminal(session) {
      for (const conversation of session.aiSessions.conversations) discardConversation(conversation);
      session.aiSessions.clear();
    },
    settings(value) {
      const lines = value?.contextLines;
      contextLines = Number.isInteger(lines) && lines >= 10 && lines <= 500 ? lines : defaultContextLines;
      searchReady = Boolean(value?.hasBraveKey && value.searchEnabled !== false);
      renderControls();
    },
    render,
  };
}
