import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TerminalAiSessions } from '../src/ai-sessions.js';

test('new sessions and drafts belong to the terminal that created them', () => {
  const first = new TerminalAiSessions();
  const second = new TerminalAiSessions();
  const original = first.current;
  original.turns.push({ question: 'explain log A', answer: 'answer A' });
  original.draft = 'follow-up A';
  original.pinned = { text: 'log A' };
  const added = first.create();
  assert.equal(added.number, 2);
  assert.equal(first.current, added);
  assert.deepEqual(added.turns, []);
  assert.equal(added.draft, '');
  assert.equal(second.current.number, 1);
  assert.deepEqual(second.current.turns, []);
  assert.equal(second.current.pinned, undefined);
  assert.deepEqual(first.conversations, [added, original]);

  first.remove(added);
  assert.equal(first.current, original);
  assert.equal(first.current.draft, 'follow-up A');
});

test('removing the last conversation keeps a blank session, while closing clears the terminal', () => {
  const first = new TerminalAiSessions();
  const another = new TerminalAiSessions();
  first.remove(first.current);
  assert.equal(first.current.number, 2);
  assert.equal(first.conversations.length, 1);
  first.create();
  first.clear();
  assert.equal(first.current, undefined);
  assert.deepEqual(first.conversations, []);
  assert.equal(another.conversations.length, 1);

  const reopened = new TerminalAiSessions();
  assert.equal(reopened.current.number, 1);
  assert.deepEqual(reopened.current.turns, []);
});
