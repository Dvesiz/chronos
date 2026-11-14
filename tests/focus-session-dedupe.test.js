const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const SRC = fs.readFileSync('app/src/main/assets/www/app.js', 'utf8');
const doc = { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}, createElement: () => ({ style: { setProperty() {} }, appendChild() {}, classList: { add() {}, remove() {}, toggle() {} } }) };
const state = { template: [], days: {}, pomo: { sessions: {} } };
const ctx = { console, Date, Math, JSON, Number, String, Array, Object, Promise, setTimeout, clearTimeout,
  navigator: { vibrate() {}, share() { return Promise.resolve(); }, clipboard: { writeText() { return Promise.resolve(); } } },
  confirm: () => true, alert() {}, document: doc, localStorage: { getItem: () => JSON.stringify(state), setItem() {}, removeItem() {} }, window: {}, performance: { now: () => Date.now() } };
vm.createContext(ctx); vm.runInContext(SRC, ctx);
assert.equal(typeof ctx.dedupeFocusSessions, 'function', '需要独立的专注记录去重函数');
const sessions = [
  { sessionId: 's1', start: 1000, end: 2000, seconds: 1000, title: '数学' },
  { sessionId: 's1', start: 1000, end: 2000, seconds: 1000, title: '数学' },
  { sessionId: 's2', start: 3000, end: 4000, seconds: 1000, title: '英语' }
];
const result = ctx.dedupeFocusSessions(sessions);
assert.equal(result.length, 2, '同一 sessionId 只能保留一条记录');
assert.deepEqual(result.map(s => s.sessionId), ['s1', 's2']);
console.log('✓ 专注记录：相同 sessionId 去重，不重复统计');
