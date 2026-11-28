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
  assert.equal(validateEvent({
    eventId: 'evt-field-path', deviceId: 'dev-1', baseSeq: 1,
    ops: [{ op: 'set', path: ['days', 'd', 'tasks', '@id:t1', 'status'], value: 'doing' }]
  }).ok, true, 'stable array ID path should be accepted');
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

test('applies stable task field paths without replacing concurrent timer fields', () => {
  const remote = {
    days: {
      '2026-11-17': {
        tasks: [{ id: '2026-11-17:t1', title: '数学', status: 'doing', focusStart: 1731840000000, focusAcc: 120 }]
      }
    }
  };
  const next = applyOps(remote, [{
    op: 'set', path: ['days', '2026-11-17', 'tasks', '@id:2026-11-17:t1', 'note'], value: '错题整理'
  }]);
  const task = next.days['2026-11-17'].tasks[0];
  assert.equal(task.note, '错题整理');
  assert.equal(task.status, 'doing', '只改备注不能覆盖远端正在运行的任务状态');
  assert.equal(task.focusStart, 1731840000000, '只改备注不能清除远端计时起点');
  assert.equal(task.focusAcc, 120, '只改备注不能覆盖已累计时长');
  assert.equal(remote.days['2026-11-17'].tasks[0].note, undefined, '操作不能修改输入快照');
});

test('adds and removes array elements by stable id paths', () => {
  const before = { days: { d: { tasks: [{ id: 't1', title: 'A' }] } } };
  const added = applyOps(before, [{ op: 'set', path: ['days', 'd', 'tasks', '@id:t2'], value: { id: 't2', title: 'B' } }]);
  assert.deepEqual(added.days.d.tasks.map(task => task.id), ['t1', 't2']);
  const removed = applyOps(added, [{ op: 'remove', path: ['days', 'd', 'tasks', '@id:t1'] }]);
  assert.deepEqual(removed.days.d.tasks.map(task => task.id), ['t2']);
});

test('按 ID 新增任务时，缺失的任务列表应初始化成数组', () => {
  const next = applyOps({ days: { d: {} } }, [
    { op: 'set', path: ['days', 'd', 'tasks', '@id:t1'], value: { id: 't1', status: 'todo' } }
  ]);
  assert.deepEqual(next.days.d.tasks, [{ id: 't1', status: 'todo' }]);
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
