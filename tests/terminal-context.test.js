import assert from 'node:assert/strict';
import { test } from 'node:test';
import xterm from '@xterm/xterm';
import { recentContext, selectedContext } from '../src/terminal-context.js';

test('captures the newest terminal rows and rejoins soft wraps without ANSI escapes', async () => {
  const term = new xterm.Terminal({ cols: 8, rows: 5, scrollback: 20, allowProposedApi: true });
  try {
    await new Promise(resolve => term.write('\x1b[31mold\x1b[0m\r\nwrapped-line\r\n最新\r\n\r\n', resolve));
    assert.deepEqual(recentContext(term, 3), { text: 'wrapped-line\n最新', truncated: false });
    assert.equal(recentContext(term, 1).text, '最新');
  } finally {
    term.dispose();
  }
});

test('bounds selected content without cutting a Unicode pair and preserves whitespace', () => {
  assert.deepEqual(selectedContext({ getSelection: () => '  log\r\n\u0000tail  ' }), {
    text: '  log\ntail  ', truncated: false,
  });
  assert.deepEqual(selectedContext({ getSelection: () => 'x'.repeat(15_999) + '😀' }), {
    text: 'x'.repeat(15_999), truncated: true,
  });
  assert.equal(selectedContext({ getSelection: () => ' ' }), null);
});
