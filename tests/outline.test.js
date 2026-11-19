import assert from 'node:assert/strict';
import { test } from 'node:test';
import xterm from '@xterm/xterm';
import { echoedCommand, makeOutline } from '../src/outline.js';

function terminal() {
  const handlers = new Map();
  const lines = [];
  let feed;
  const active = { type: 'normal', baseY: 0, cursorY: 0, cursorX: 0, getLine: index => lines[index] };
  return {
    rows: 6,
    cols: 80,
    buffer: { active },
    parser: { registerOscHandler: (code, handler) => handlers.set(code, handler) },
    onLineFeed(handler) { feed = handler; },
    feed() { feed(); },
    osc(code, payload) { handlers.get(code)(payload); },
    line(index, text) {
      lines[index] = { translateToString: (trim, start, end) => text.slice(start, end).trimEnd() };
      active.cursorY = index;
      active.cursorX = text.length;
    },
    scrollToLine(line) { this.scrolledTo = line; },
    registerDecoration(options) {
      const decoration = { ...options, disposed: false, dispose() { this.disposed = true; } };
      this.decoration = decoration;
      return decoration;
    },
    registerMarker(offset) {
      let dispose;
      return { line: active.cursorY + offset, isDisposed: false, onDispose: handler => { dispose = handler; },
        dispose() { this.isDisposed = true; dispose(); } };
    },
  };
}

test('ignores authentication prompts and accepts common echoed commands', () => {
  for (const prompt of ["alex@host's password: ", 'Password: ', 'client_loop: send disconnect: Broken pipe']) {
    assert.equal(echoedCommand(prompt), null);
  }
  assert.equal(echoedCommand('[ops@host ~]# pwd'), 'pwd');
  assert.equal(echoedCommand('ops@host:~$ ls -la'), 'ls -la');
  assert.equal(echoedCommand('buildhost% git status'), 'git status');
});

test('records commands per tab via prompt markers, jumps without executing, and clears on trim', () => {
  const first = terminal();
  const second = terminal();
  let ready = false;
  const outline = makeOutline(first, () => ready, () => {});
  const isolated = makeOutline(second, () => true, () => {});
  first.line(0, 'ops@host:~$ not-authenticated');
  outline.input('not-authenticated\r');
  assert.equal(outline.entries.length, 0);
  ready = true;
  first.line(1, 'ops@host:~$ pwd');
  outline.input('pwd\r');
  first.line(2, '');
  first.feed();
  first.line(2, 'custom > ');
  first.osc(133, 'B');
  first.line(2, 'custom > echo hello');
  outline.input('echo hello\r');
  first.osc(133, 'C');
  first.osc(633, 'A');
  first.line(4, 'custom > ');
  first.osc(633, 'B');
  first.osc(633, 'E;printf a\\x3bb;nonce');
  first.osc(633, 'C');
  assert.deepEqual(outline.entries.map(entry => entry.text), ['pwd', 'echo hello', 'printf a;b']);
  assert.equal(isolated.entries.length, 0);
  assert.equal(outline.jump(outline.entries[1]), true);
  assert.equal(first.scrolledTo, 0);
  assert.equal(first.decoration.marker.line, 2);
  const firstHighlight = first.decoration;
  assert.equal(outline.jump(outline.entries[2]), true);
  assert.equal(firstHighlight.disposed, true);
  outline.entries[0].marker.dispose();
  assert.equal(outline.entries.length, 2);
  outline.reset();
  assert.equal(outline.entries.length, 0);
  assert.equal(first.decoration.disposed, true);
});

const write = (term, text) => new Promise(resolve => term.write(text, resolve));

test('xterm captures cat after delayed echo on a custom prompt, not its output or hidden answers', async () => {
  const term = new xterm.Terminal({ cols: 40, rows: 8, scrollback: 100 });
  let interactive = false;
  const outline = makeOutline(term, () => interactive, () => {});
  await write(term, "user@host's password: ");
  outline.input('ssh secret\r');
  await write(term, '\r\n');
  interactive = true;
  await write(term, 'dev ~/project ❯ ');
  outline.input('cat README.md\r');
  assert.equal(outline.entries.length, 0);
  await write(term, 'cat READ');
  await write(term, 'ME.md\r\n# file content\r\nnot a command $ ls\r\ndev ~/project ❯ ');
  assert.deepEqual(outline.entries.map(entry => entry.text), ['cat README.md']);
  await write(term, 'sudo -v\r\n[sudo] password for user: ');
  outline.input('sudo secret\r');
  await write(term, '\r\ndev ~/project ❯ ');
  assert.deepEqual(outline.entries.map(entry => entry.text), ['cat README.md']);
  term.dispose();
});

test('xterm handles recalled commands, wrapped echo and both partial and complete shell integration', async () => {
  const term = new xterm.Terminal({ cols: 30, rows: 10 });
  const outline = makeOutline(term, () => true, () => {});
  await write(term, '\x1b]133;A\x07build% ');
  const long = 'cat folder/with-a-long-filename.txt';
  outline.input(long + '\r');
  await write(term, long + '\r\n');
  await write(term, '\x1b]133;A\x07build% ');
  outline.input('\x1b[A');
  await write(term, 'ls -la');
  outline.input('\r');
  await write(term, '\r\n');
  await write(term, '\x1b]133;A\x07build% \x1b]133;B\x07');
  outline.input('pwd\r');
  await write(term, 'pwd\r\n\x1b]133;C\x07/build\r\n');
  assert.deepEqual(outline.entries.map(entry => entry.text), [long, 'ls -la', 'pwd']);
  term.dispose();
});

test('xterm markers address the exact command in scrollback for jumping and highlighting', async () => {
  const term = new xterm.Terminal({ rows: 6, cols: 30, allowProposedApi: true });
  const outline = makeOutline(term, () => true, () => {});
  await write(term, 'banner\r\n'.repeat(8) + '$ ');
  outline.input('cat file\r');
  await write(term, 'cat file\r\n' + 'contents\r\n'.repeat(16));
  const [entry] = outline.entries;
  assert.equal(entry.text, 'cat file');
  assert.equal(term.buffer.active.getLine(entry.marker.line).translateToString(true), '$ cat file');
  assert.ok(term.buffer.active.viewportY > entry.marker.line);
  let target;
  term.scrollToLine = line => { target = line; };
  assert.equal(outline.jump(entry), true);
  assert.equal(target, entry.marker.line - 2);
  assert.equal(term.registerDecoration({ marker: entry.marker }).marker, entry.marker);
  entry.marker.dispose();
  assert.equal(outline.jump(entry), false);
  term.dispose();
});
