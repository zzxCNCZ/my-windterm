import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { directoryHooks, terminalDirectory } from '../src/terminal-directory.js';
import { clampSize } from '../src/layout.js';

test('decodes shell directory messages without treating the URI host as a connection target', () => {
  assert.equal(terminalDirectory(7, 'file://[::1]/tmp/%E6%B5%8B%E8%AF%95%20%23%3F%25'), '/tmp/测试 #?%');
  assert.equal(terminalDirectory(7, 'file:///tmp/link/../'), '/tmp/link/../');
  assert.equal(terminalDirectory(7, 'file:///'), '/');
  assert.equal(terminalDirectory(1337, 'CurrentDir=/tmp/% hello #?'), '/tmp/% hello #?');
});

test('ignores unrelated and invalid directory messages', () => {
  for (const payload of ['https://example.org/etc', 'file://host', 'file:///tmp/%ZZ', 'file:///tmp/%00', 'file:///path#fragment', 'file:///path?param', 'file://user@host/path']) {
    assert.equal(terminalDirectory(7, payload), null);
  }
  for (const payload of ['SetMark', 'CurrentDir=relative', 'CurrentDir=/test\n', 'CurrentDir=/' + '测'.repeat(1400)]) {
    assert.equal(terminalDirectory(1337, payload), null);
  }
});

test('Bash shell hook preserves the existing prompt action and emits the working directory', { skip: process.platform === 'win32' }, () => {
  const script = 'PROMPT_COMMAND=\'printf "existing\\n"\'\n' + directoryHooks.bash +
    '\nunset TMUX; PWD="/tmp/远端 工作"; eval "$PROMPT_COMMAND"';
  const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'existing\n\x1b]1337;CurrentDir=/tmp/远端 工作\x07');
});

test('Zsh hook is registered and emits a tmux passthrough sequence when nested', { skip: process.platform === 'win32' }, () => {
  const script = directoryHooks.zsh + '\n[[ ${precmd_functions[(Ie)__mwt_report_cwd]} != 0 ]] || exit 3\n' +
    'TMUX=fixture; PWD="/tmp/zsh path"; __mwt_report_cwd';
  const result = spawnSync('/bin/zsh', ['-f', '-c', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '\x1bPtmux;\x1b\x1b]1337;CurrentDir=/tmp/zsh path\x07\x1b\\');
});

test('splitters round and clamp dimensions without collapsing panels below their minimum', () => {
  assert.equal(clampSize(210.6, 162, 330), 211);
  assert.equal(clampSize(400, 162, 330), 330);
  assert.equal(clampSize(80, 162, 330), 162);
  assert.equal(clampSize(80, 162, 50), 162);
});
