import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeEmail,
  validateEmail,
  validateAvatarData,
  validateEvent,
  applyOps,
  diffState,
  DEFAULT_STATE
} from '../src/core.js';

test('normalizes and validates emails', () => {
  assert.equal(normalizeEmail('  USER@Example.COM '), 'user@example.com');
  assert.equal(validateEmail('user@example.com'), true);
  assert.equal(validateEmail('bad'), false);
  assert.equal(validateEmail(''), false);
});

test('accepts bounded custom avatar data URLs', () => {
  assert.equal(validateAvatarData('data:image/jpeg;base64,abc'), true);
  assert.equal(validateAvatarData(''), true);
  assert.equal(validateAvatarData('https://example.com/avatar.jpg'), false);
  assert.equal(validateAvatarData('data:text/html;base64,abc'), false);
});

test('rejects oversized or unsafe sync events', () => {
  const valid = validateEvent({
    eventId: 'evt-1', deviceId: 'dev-1', baseSeq: 0,
    ops: [{ op: 'set', path: ['days', '2026-10-29'], value: { tasks: [] } }],
    clientAt: 1730000000000
  });
  assert.equal(valid.ok, true);
  assert.equal(validateEvent({ eventId: 'x', deviceId: 'd', baseSeq: -1, ops: [] }).ok, false);
  assert.equal(validateEvent({ eventId: 'x', deviceId: 'd', baseSeq: 0, ops: [{ op: 'drop-table', path: [] }] }).ok, false);
});

test('applies set, remove and replace operations without mutating input', () => {
  const before = { days: {}, template: [{ id: 't1', title: 'Focus' }] };
  const after = applyOps(before, [
    { op: 'set', path: ['days', '2026-10-29'], value: { tasks: [] } },
    { op: 'set', path: ['template', '0', 'title'], value: 'Deep work' },
    { op: 'remove', path: ['days', '2026-10-29', 'tasks'] }
  ]);
  assert.deepEqual(before, { days: {}, template: [{ id: 't1', title: 'Focus' }] });
  assert.equal(after.template[0].title, 'Deep work');
  assert.deepEqual(after.days['2026-10-29'], {});

  const replaced = applyOps(before, [{ op: 'replace', path: [], value: DEFAULT_STATE }]);
  assert.notEqual(replaced, DEFAULT_STATE);
  assert.deepEqual(replaced, DEFAULT_STATE);
});

test('creates deterministic operations for changed state', () => {
  const before = { days: {}, settings: { theme: 'light', remind: true } };
  const after = { days: { '2026-10-29': { tasks: [] } }, settings: { theme: 'dark', remind: true } };
  const ops = diffState(before, after);
  assert.deepEqual(ops, [
    { op: 'set', path: ['days', '2026-10-29'], value: { tasks: [] } },
    { op: 'set', path: ['settings', 'theme'], value: 'dark' }
  ]);
});
