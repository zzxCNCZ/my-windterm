import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import { test } from 'node:test';
import { makeFiler } from '../src/filer.js';

test('follows the active remote terminal and discards requests after disabling or switching tabs', async () => {
  const nodes = new Map();
  function node() {
    return {
      setAttribute() {}, addEventListener() {}, replaceChildren() {},
      disabled: false,
    };
  }
  const oldDocument = globalThis.document;
  globalThis.document = {
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, node());
      return nodes.get(selector);
    },
    createElement: node,
  };
  const options = [];
  const calls = [];
  let resolveStale;
  const errors = [];
  const directoryInput = () => nodes.get('#filer-path').value;
  try {
    const filer = makeFiler({
      invoke(command, { id, path }) {
        calls.push([command, id, path]);
        if (path === '/stale') return new Promise(resolve => { resolveStale = resolve; });
        if (path === '/unavailable') return Promise.reject('SFTP 无法访问此路径');
        return Promise.resolve({ path: path ?? '/home', parent: '/', entries: [] });
      },
      report: error => errors.push(error), status() {}, run() {}, directoryHelp() {},
      follow: false, saveFollow: value => options.push(value),
    });
    const first = { runtimeId: 'first', state: 'running', sftpReady: true, connection: { host: 'first' }, directory: '/first' };
    const second = { runtimeId: 'second', state: 'running', sftpReady: true, connection: { host: 'second' }, directory: '/second' };
    filer.setSession(first);
    await wait(0);
    assert.equal(directoryInput(), '/home');
    filer.toggleFollow();
    await wait(0);
    assert.equal(directoryInput(), '/first');
    first.directory = '/unavailable';
    filer.directoryChanged(first);
    await wait(160);
    assert.equal(directoryInput(), '/first');
    assert.deepEqual(errors, ['SFTP 无法访问此路径']);
    first.directory = '/stale';
    filer.directoryChanged(first);
    await wait(160);
    const stale = resolveStale;
    filer.setSession(second);
    stale({ path: '/stale', entries: [] });
    await wait(0);
    assert.equal(directoryInput(), '/second');
    assert.deepEqual(calls.at(-1), ['list_remote_directory', 'second', '/second']);
    const count = calls.length;
    first.directory = '/background';
    filer.directoryChanged(first);
    second.directory = '/cancelled';
    filer.directoryChanged(second);
    filer.toggleFollow();
    await wait(160);
    assert.equal(calls.length, count);
    assert.deepEqual(options, [true, false]);
    filer.toggleFollow();
    await wait(0);
    filer.switchMode('local');
    await wait(0);
    second.directory = '/stay-local';
    filer.directoryChanged(second);
    await wait(160);
    assert.equal(calls.at(-1)[0], 'list_directory');
    assert.equal(directoryInput(), '/home');
  } finally {
    globalThis.document = oldDocument;
  }
});
