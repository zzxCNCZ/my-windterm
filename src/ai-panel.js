import { Channel } from '@tauri-apps/api/core';
import { t } from './i18n.js';
import { defaultContextLines } from './terminal-context.js';

const errorText = error => error instanceof Error ? error.message : String(error);

function node(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

const titleFor = question => question.replace(/\s+/g, ' ').slice(0, 70);

function messageBody(content) {
  const body = node('div', 'ai-message-text');
  let lines = [], inCode = false;
  const append = () => {
    if (lines.length) body.append(node(inCode ? 'pre' : 'div', '', lines.join('\n')));
    lines = [];
  };
  for (const line of content.split('\n')) {
    if (line.startsWith('```')) {
      append();
      inCode = !inCode;
    } else {
      lines.push(line);
    }
  }
  append();
  return body;
}

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

  function sourceButtons(sources) {
    const conversation = thread();
    const list = node('div', 'ai-sources');
    list.append(node('span', '', t('联网搜索结果')));
    for (const source of sources) {
      if (typeof source?.url !== 'string') continue;
      const link = node('button', 'ai-source', source.title || source.url);
      link.type = 'button';
      link.title = source.url;
      link.addEventListener('click', () => void invoke('open_ai_source', { url: source.url })
        .catch(error => { if (!conversation.disposed) setStatus(conversation, errorText(error), true); }));
      list.append(link);
    }
    return list;
  }

  function message(role, text, reasoning = '') {
    const article = node('article', `ai-message ai-message-${role}`);
    const body = messageBody(text);
    article.append(node('strong', '', t(role === 'user' ? '你' : 'AI')));
    const details = node('details', 'ai-reasoning');
    const summary = node('summary', '', t('思考过程'));
    const trace = node('pre', '', reasoning);
    details.append(summary, trace);
    details.hidden = !reasoning;
    if (role === 'assistant') {
      details.addEventListener('toggle', () => {
        if (details.open && atBottom) messages.scrollTop = messages.scrollHeight;
      });
      article.append(details);
    }
    article.append(body);
    return { article, body, details, summary, trace };
  }

  function renderMessages(follow = true) {
    const scrollTop = messages.scrollTop;
    const conversation = thread();
    const running = conversation?.running;
    const content = [];
    for (const turn of conversation?.turns ?? []) {
      content.push(message('user', turn.question).article);
      const { article } = message('assistant', turn.answer, turn.reasoning);
      if (Array.isArray(turn.sources) && turn.sources.length) article.append(sourceButtons(turn.sources));
      content.push(article);
    }
    liveReply = undefined;
    const pending = running || conversation?.interrupted;
    if (pending) {
      content.push(message('user', pending.question).article);
      const bubble = message('assistant', pending.text, pending.reasoning);
      bubble.article.hidden = !pending.text && !pending.reasoning;
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
      const { article, body, details, summary, trace } = liveReply;
      article.hidden = !target.text && !target.reasoning;
      details.hidden = !target.reasoning;
      const summaryText = t(target.stage === 'reasoningDelta' ? '正在思考…' : '思考过程');
      if (summary.textContent !== summaryText) summary.textContent = summaryText;
      if (trace.textContent !== target.reasoning) trace.textContent = target.reasoning;
      // Leave the details node in place so its expanded state survives streaming.
      if (body.dataset.text !== target.text) {
        body.dataset.text = target.text;
        body.replaceChildren(...messageBody(target.text).childNodes);
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
    const target = { id: newId(), question, text: '', reasoning: '' };
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
    const progress = new Channel(({ kind, text }) => {
      if (!target.started) {
        target.started = true;
        if (target.stopping) void stopRequest(conversation, target);
      }
      if (conversation.disposed || conversation.running !== target || target.stopping) return;
      if (kind === 'thinking') target.text = '';
      if (kind === 'reasoningDelta') target.reasoning += text;
      if (kind === 'answerDelta') target.text += text;
      if (kind !== target.stage) {
        const labels = { thinking: '正在等待 AI 回复…', searching: '正在联网搜索…',
          reasoningDelta: '正在思考…', answerDelta: '正在输出回答…' };
        setStatus(conversation, labels[kind]);
        target.stage = kind;
      }
      renderStream(conversation, target);
    });
    try {
      const answer = await invoke('ask_ai', { request, progress });
      if (conversation.disposed) return;
      const turn = { question, answer: answer.text, reasoning: answer.reasoning, sources: answer.sources };
      conversation.turns.push(turn);
      conversation.draft = '';
      conversation.pinned = undefined;
      setStatus(conversation);
    } catch (error) {
      if (conversation.disposed) return;
      const detail = errorText(error);
      if (target.text || target.reasoning) conversation.interrupted = target;
      setStatus(conversation, detail, detail !== 'AI 问答已停止。');
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
