import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filerMode } from '../src/filer.js';
import { connectionTabs, filterSessions, restoreTabs, savedTabs, withoutGroup } from '../src/model.js';

const first = { id: '00000000-0000-4000-8000-000000000001', name: 'Build', host: 'build.example.org', username: 'ops', groupId: 'g' };
const second = { id: '00000000-0000-4000-8000-000000000002', name: 'Backup', host: 'backup.example.org', username: 'root', groupId: null };
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

test('migrates old saved tabs without changing their original tmux identity', () => {
  assert.deepEqual(restoreTabs(profile, { ids: [first.id, 'gone', first.id, second.id], active: 'gone' }), {
    tabs: [{ id: first.id, connection: first }, { id: second.id, connection: second }], active: second.id,
  });
  assert.deepEqual(restoreTabs(profile, { ids: {} }), { tabs: [], active: null });
});

test('saves and restores distinct instances of the same connection independently', () => {
  const firstTab = { id: '10000000-0000-4000-8000-000000000001', connection: first };
  const secondTab = { id: '10000000-0000-4000-8000-000000000002', connection: first };
  const otherTab = { id: '10000000-0000-4000-8000-000000000003', connection: second };
  const openTabs = [firstTab, secondTab, otherTab];
  const saved = savedTabs(openTabs, secondTab.id);
  assert.deepEqual(restoreTabs(profile, saved), { tabs: openTabs, active: secondTab.id });
  assert.deepEqual(connectionTabs(openTabs, first.id), [firstTab, secondTab]);
  assert.deepEqual(restoreTabs(profile, savedTabs(openTabs.slice(1), secondTab.id)),
    { tabs: [secondTab, otherTab], active: secondTab.id });
  assert.deepEqual(restoreTabs({ ...profile, connections: [second] }, saved), { tabs: [otherTab], active: otherTab.id });
  assert.deepEqual(restoreTabs(profile, { tabs: [...saved.tabs, saved.tabs[0], null] }).tabs, openTabs);
});
