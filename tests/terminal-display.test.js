import assert from 'node:assert/strict';
import { test } from 'node:test';
import xterm from '@xterm/xterm';
import { colorCells, colorTokens, makeTerminalColors } from '../src/terminal-colors.js';

const write = (term, value) => new Promise(resolve => term.write(value, resolve));

test('classifies prompt, commands, options, addresses, URLs, source tokens and errors', () => {
  const line = 'ops@host:~$ curl --fail https://example.org/ 192.168.1.1 error';
  const tokens = colorTokens(line, 'curl --fail https://example.org/ 192.168.1.1 error');
  assert.deepEqual(tokens.map(({ start, end }) => line.slice(start, end).trim()),
    ['ops@host:~$', 'curl', '--fail', 'https://example.org/', '192.168.1.1', 'error']);
  assert.notEqual(tokens[3].color, tokens[4].color);
  const code = 'const host = "远端"; return 42;';
  assert.deepEqual(colorTokens(code).map(({ start, end }) => code.slice(start, end)), ['const', '"远端"', 'return', '42']);
  assert.equal(colorTokens('addr fd00::1234')[0].color, tokens[4].color);
});

test('maps Unicode spans to terminal columns without overriding ANSI or hidden cells', async () => {
  const term = new xterm.Terminal({ cols: 60 });
  await write(term, '目录 \x1b[31mERROR\x1b[0m \x1b[8m42\x1b[0m "文件" --flag');
  const row = term.buffer.active.getLine(0);
  const text = row.translateToString(true);
  const runs = colorCells(row, term.buffer.active.getNullCell(), colorTokens(text), term.cols);
  assert.deepEqual(runs.map(({ x, width }) => [x, width]), [[14, 6], [21, 6]]);
  assert.equal(row.translateToString(true), text);
  term.dispose();
});

test('decorates only the visible normal buffer and removes decorations when disabled', async () => {
  const term = new xterm.Terminal({ rows: 4, cols: 40, allowProposedApi: true });
  const savedFrame = globalThis.requestAnimationFrame;
  const savedCancel = globalThis.cancelAnimationFrame;
  let frame;
  globalThis.requestAnimationFrame = callback => { frame = callback; return 1; };
  globalThis.cancelAnimationFrame = () => { frame = undefined; };
  const colors = makeTerminalColors(term, () => [], () => true);
  try {
    await write(term, 'ERROR outside viewport\r\n'.repeat(8) + 'addr 192.168.0.1');
    colors.schedule();
    frame();
    assert.ok(term.markers.length > 0 && term.markers.length <= term.rows);
    assert.ok(term.markers.every(marker => marker.line >= term.buffer.active.viewportY));
    await write(term, '\x1b[?1049hignored 10');
    colors.schedule();
    frame();
    assert.equal(term.markers.length, 0);
    await write(term, '\x1b[?1049l');
    colors.schedule();
    frame();
    assert.ok(term.markers.length > 0);
    colors.enable(false);
    assert.equal(term.markers.length, 0);
  } finally {
    colors.dispose();
    term.dispose();
    if (savedFrame === undefined) delete globalThis.requestAnimationFrame; else globalThis.requestAnimationFrame = savedFrame;
    if (savedCancel === undefined) delete globalThis.cancelAnimationFrame; else globalThis.cancelAnimationFrame = savedCancel;
  }
});

test('searches scrollback and wrapped output, navigates both ways, and clears selection on close', async () => {
  const savedWindow = globalThis.window;
  const savedSelf = globalThis.self;
  globalThis.window = { clearTimeout, setTimeout: (callback, delay) => setTimeout(callback, delay).unref() };
  globalThis.self = globalThis;
  const term = new xterm.Terminal({ cols: 20, rows: 5, scrollback: 100, allowProposedApi: true });
  try {
    await write(term, 'cat report.txt\r\n' + '012345678901234567匹配内容\r\n' + 'log\r\n'.repeat(12) + 'CAT another.txt');
    let selection, scroll;
    term.getSelectionPosition = () => selection;
    term.clearSelection = () => { selection = undefined; };
    term.select = (column, row, length) => {
      selection = { start: { x: column, y: row }, end: { x: column + length, y: row } };
    };
    term.scrollLines = amount => { scroll = amount; };
    const { makeTerminalSearch } = await import('../src/terminal-search.js');
    const search = makeTerminalSearch(term, () => {});
    search.start();
    search.config('cat', true);
    assert.equal(search.state.count, 1);
    assert.equal(selection.start.y, 0);
    assert.ok(scroll < 0);
    search.config('cat', false);
    assert.equal(search.state.count, 2);
    const first = selection.start.y;
    search.next();
    assert.notEqual(selection.start.y, first);
    search.next(true);
    assert.equal(selection.start.y, first);
    search.config('匹配内容');
    assert.equal(search.state.count, 1);
    search.config('missing');
    assert.equal(search.state.found, false);
    search.config('report.txt');
    assert.equal(search.state.found, true);
    search.stop();
    assert.equal(selection, undefined);
    assert.equal(search.state.query, 'report.txt');
    search.dispose();
  } finally {
    term.dispose();
    if (savedWindow === undefined) delete globalThis.window; else globalThis.window = savedWindow;
    if (savedSelf === undefined) delete globalThis.self; else globalThis.self = savedSelf;
  }
});
