import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filerMode } from '../src/filer.js';
import { filterSessions, restoreTabs, withoutGroup } from '../src/model.js';

const first = { id: 'a', name: 'Build', host: 'build.example.org', username: 'ops', groupId: 'g' };
const second = { id: 'b', name: 'Backup', host: 'backup.example.org', username: 'root', groupId: null };
const profile = { version: 1, groups: [{ id: 'g', name: '开发环境' }], connections: [first, second] };

test('Filer follows an active SSH tab without overriding its local preference', () => {
  assert.equal(filerMode(undefined, undefined), 'local');
  assert.equal(filerMode({ state: 'idle', runtimeId: null }, 'remote'), 'local');
  assert.equal(filerMode({ state: 'starting', runtimeId: null }, 'remote'), 'remote');
  assert.equal(filerMode({ state: 'running', runtimeId: 'abc' }, 'remote'), 'remote');
  assert.equal(filerMode({ state: 'running', runtimeId: 'abc' }, 'local'), 'local');
  assert.equal(filerMode({ state: 'stopping', runtimeId: null }, 'remote'), 'local');
});

test('filters by group, user and case-insensitive host', () => {
  assert.deepEqual(filterSessions(profile, '开发').groups[0].connections, [first]);
  assert.deepEqual(filterSessions(profile, 'ROOT').loose, [second]);
  assert.deepEqual(filterSessions(profile, ' BUILD.EXAMPLE ').groups[0].connections, [first]);
  assert.deepEqual(filterSessions(profile, 'missing'), { groups: [], loose: [] });
});

test('removing a group moves its connections instead of deleting them', () => {
  const updated = withoutGroup(profile, 'g');
  assert.deepEqual(updated.groups, []);
  assert.deepEqual(updated.connections, [{ ...first, groupId: null }, second]);
  assert.equal(first.groupId, 'g');
});

test('restores only saved, unique tab IDs and selects a valid tab', () => {
  assert.deepEqual(restoreTabs(profile, { ids: ['a', 'gone', 'a', 'b'], active: 'gone' }), { connections: [first, second], active: 'b' });
  assert.deepEqual(restoreTabs(profile, { ids: ['b', 'a'], active: 'b' }), { connections: [second, first], active: 'b' });
  assert.deepEqual(restoreTabs(profile, { ids: {} }), { connections: [], active: null });
});
