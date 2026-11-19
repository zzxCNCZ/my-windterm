import { Channel } from '@tauri-apps/api/core';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { terminalDirectory } from './terminal-directory.js';
import { makeOutline } from './outline.js';
import { makeTerminalColors } from './terminal-colors.js';
import { makeTerminalSearch } from './terminal-search.js';
import { terminalOptions } from './appearance.js';
import { t } from './i18n.js';
import '@xterm/xterm/css/xterm.css';

const encoder = new TextEncoder();

export function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function makeTerminal({ parent, id: tabId, connection, invoke, changed, directoryChanged, outlineChanged, searchChanged, report, numbers, semanticColors, appearance, remoteFiles }) {
  const pane = document.createElement('div');
  const gutter = document.createElement('div');
  const host = document.createElement('div');
  pane.className = 'terminal-pane';
  pane.hidden = true;
  pane.setAttribute('role', 'tabpanel');
  pane.id = `terminal-${tabId}`;
  host.className = 'terminal-host';
  gutter.className = 'gutter';
  gutter.setAttribute('aria-hidden', 'true');
  pane.append(gutter, host);
  parent.append(pane);

  const term = new Terminal({
    allowProposedApi: true,
    overviewRulerWidth: 5,
    ...terminalOptions(appearance), lineHeight: 1.15, scrollback: 12000,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  let opened = false, runtime = null, input = Promise.resolve(), gutterFrame = 0;
  let lastGutter = '', interactive = false;
  let starting, stopping;
  const outline = makeOutline(term, () => Boolean(runtime && interactive), () => {
    outlineChanged(session);
    colors.schedule();
  });
  const colors = makeTerminalColors(term, () => outline.entries, () => opened && !pane.hidden);
  colors.setPalette(appearance.colors);
  const search = makeTerminalSearch(term, () => searchChanged(session));
  const session = {
    id: tabId, connection, liveConnection: null, state: 'idle', pane, sftpReady: false, directory: null, outline, search, remoteFiles,
    get runtimeId() { return session.state === 'running' ? runtime : null; },
    show(visible, focus = false) {
      pane.hidden = !visible;
      if (!visible) { colors.clear(); return; }
      if (!opened) {
        term.open(host);
        opened = true;
        term.writeln(`\x1b[90m${t('会话未连接。使用「⟳」连接到主机。')}\x1b[0m`);
      }
      refresh();
      colors.enable(semanticColors());
      if (focus) term.focus();
    },
    refresh,
    applyAppearance(value) {
      term.options = terminalOptions(value);
      colors.setPalette(value.colors);
      refresh();
    },
    async connect() {
      if (session.state !== 'idle') return;
      refresh();
      outline.reset();
      term.reset();
      const id = newId();
      runtime = id;
      interactive = false;
      session.sftpReady = false;
      session.directory = null;
      input = Promise.resolve();
      session.liveConnection = session.connection;
      session.state = 'starting';
      changed();
      if (!remoteFiles && session.liveConnection.password) {
        term.writeln(t('Windows 版请在 SSH 提示时手动输入密码。'));
      }
      const events = new Channel();
      events.onmessage = event => {
        if (runtime !== id) return;
        if (event.kind === 'data') {
          interactive ||= event.interactive;
          term.write(Uint8Array.from(atob(event.data), char => char.charCodeAt(0)));
        }
        if (event.kind === 'exit') {
          term.write('', () => {
            if (runtime !== id) return;
            runtime = null;
            interactive = false;
            outline.endInput();
            session.sftpReady = false;
            session.directory = null;
            session.liveConnection = null;
            session.state = 'idle';
            term.writeln(`\r\n\x1b[90m[${t('SSH 已结束：')}${event.detail}]\x1b[0m`);
            changed();
          });
        }
      };
      try {
        starting = invoke('start_session', { id, tabId, connection: session.liveConnection, cols: term.cols, rows: term.rows, events });
        await starting;
        if (runtime === id) {
          session.state = 'running';
          changed();
          resize();
          if (!pane.hidden) term.focus();
          if (remoteFiles) void invoke('wait_for_sftp', { id }).then(() => {
            if (runtime !== id) return;
            session.sftpReady = true;
            changed();
          }).catch(() => {});
        }
      } catch (error) {
        if (runtime === id) {
          runtime = null;
          session.directory = null;
          session.liveConnection = null;
          session.state = 'idle';
          changed();
          term.writeln(`\r\n[${t('无法启动 SSH：')}${String(error).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')}]`);
        }
        report(error);
      } finally {
        starting = undefined;
      }
    },
    async disconnect() {
      if (starting) {
        try { await starting; } catch { return; }
      }
      if (stopping) return stopping;
      if (session.state !== 'running') return;
      const id = runtime;
      session.state = 'stopping';
      try {
        stopping = invoke('stop_session', { id });
        changed();
        await stopping;
      } catch (error) {
        if (runtime === id) session.state = 'running';
        changed();
        throw error;
      } finally {
        stopping = undefined;
      }
    },
    send(text) { sendText(text); },
    clear() { term.clear(); },
    dispose() {
      runtime = null;
      search.dispose();
      outline.reset();
      colors.dispose();
      observer.disconnect();
      cancelAnimationFrame(gutterFrame);
      term.dispose();
      pane.remove();
    },
  };

  for (const code of [7, 1337]) {
    term.parser.registerOscHandler(code, payload => {
      const directory = terminalDirectory(code, payload);
      if (!directory) return false;
      if (runtime && directory !== session.directory) {
        session.directory = directory;
        directoryChanged(session);
      }
      return true;
    });
  }

  function sendText(text) {
    if (session.state !== 'running') return;
    outline.input(text);
    queue(encoder.encode(text));
  }

  function queue(bytes) {
    if (session.state !== 'running') return;
    const id = runtime;
    input = input.then(async () => {
      for (let offset = 0; offset < bytes.length && runtime === id && session.state === 'running'; offset += 24576) {
        const data = btoa(String.fromCharCode(...bytes.subarray(offset, offset + 24576)));
        await invoke('session_input', { id, data });
      }
    }).catch(report);
  }

  function resize() {
    if (session.state === 'running' && !pane.hidden) {
      void invoke('session_resize', { id: runtime, cols: term.cols, rows: term.rows }).catch(report);
    }
  }

  function refresh() {
    if (!opened || pane.hidden) return;
    gutter.hidden = !numbers();
    fit.fit();
    redrawGutter();
  }

  function redrawGutter() {
    if (pane.hidden || gutter.hidden || gutterFrame) return;
    gutterFrame = requestAnimationFrame(() => {
      gutterFrame = 0;
      if (pane.hidden || gutter.hidden) return;
      const height = host.querySelector('.xterm-screen')?.clientHeight / term.rows;
      const buffer = term.buffer.active;
      const key = `${height}/${buffer.viewportY}/${term.rows}`;
      if (!height || key === lastGutter) return;
      lastGutter = key;
      gutter.replaceChildren(...Array.from({ length: term.rows }, (_, index) => {
        const row = document.createElement('span');
        row.textContent = String(buffer.viewportY + index + 1);
        row.style.height = `${height}px`;
        row.style.lineHeight = `${height}px`;
        return row;
      }));
    });
  }

  const observer = new ResizeObserver(refresh);
  observer.observe(host);
  term.onData(sendText);
  term.onBinary(text => queue(Uint8Array.from(text, char => char.charCodeAt(0))));
  term.onResize(() => { resize(); redrawGutter(); });
  term.onScroll(redrawGutter);
  term.onWriteParsed(redrawGutter);
  term.onScroll(colors.schedule);
  term.onWriteParsed(colors.schedule);
  term.onResize(colors.schedule);
  term.buffer.onBufferChange(colors.schedule);
  return session;
}
