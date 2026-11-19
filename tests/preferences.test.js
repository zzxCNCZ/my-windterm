import assert from 'node:assert/strict';
import { test } from 'node:test';
import xterm from '@xterm/xterm';
import { ansiKeys, presets, terminalAppearance, terminalOptions } from '../src/appearance.js';
import { resolveLanguage } from '../src/i18n.js';

test('validates persisted theme values and fills missing color channels from the preset', () => {
  const appearance = terminalAppearance({ preset: 'paper', size: 100, font: 'menlo', colors: { red: '#654321', green: 'invalid' }, cursor: 'bar', blink: false });
  assert.equal(appearance.colors.red, '#654321');
  assert.equal(appearance.colors.green, presets.paper.green);
  assert.equal(appearance.colors.background, presets.paper.background);
  assert.equal(appearance.size, 30);
  assert.ok(ansiKeys.every(key => /^#[0-9a-f]{6}$/i.test(appearance.colors[key])));
  assert.deepEqual(terminalAppearance(null), terminalAppearance({ preset: 'constructor', font: 'toString' }));
  assert.deepEqual(JSON.parse(JSON.stringify(appearance)), appearance);
});

test('applies colors, font and cursor to an existing terminal without replacing scrollback', async () => {
  const terminal = new xterm.Terminal(terminalOptions(terminalAppearance()));
  await new Promise(resolve => terminal.write('preserved output', resolve));
  terminal.options = terminalOptions(terminalAppearance({ preset: 'paper', size: 17, cursor: 'underline', blink: false }));
  assert.equal(terminal.options.theme.background, presets.paper.background);
  assert.equal(terminal.options.fontSize, 17);
  assert.equal(terminal.options.cursorStyle, 'underline');
  assert.equal(terminal.options.cursorBlink, false);
  assert.equal(terminal.buffer.active.getLine(0).translateToString(true), 'preserved output');
  terminal.dispose();
});

test('resolves display locale with explicit choices and system fallback', () => {
  assert.equal(resolveLanguage('system', 'zh-Hans'), 'zh-CN');
  assert.equal(resolveLanguage('system', 'fr-FR'), 'en');
  assert.equal(resolveLanguage('en', 'zh-CN'), 'en');
  assert.equal(resolveLanguage(undefined, 'en-US'), 'zh-CN');
});
