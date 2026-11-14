const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const SRC = fs.readFileSync('app/src/main/assets/www/app.js', 'utf8');
const key = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const today = key(new Date());
const doc = { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}, createElement: () => ({ style: { setProperty() {} }, appendChild() {}, classList: { add() {}, remove() {}, toggle() {} } }) };
const state = { template: [], days: { [today]: { tasks: [
  { id:'done-late', title:'已完成晚项', start:900, end:960, status:'done' },
  { id:'todo-late', title:'未完成晚项', start:900, end:960, status:'todo' },
  { id:'done-early', title:'已完成早项', start:480, end:540, status:'skipped' },
  { id:'todo-early', title:'未完成早项', start:480, end:540, status:'todo' }
] } }, pomo: { sessions: {} } };
const ctx = { console, Date, Math, JSON, Number, String, Array, Object, Promise, setTimeout, clearTimeout,
  navigator: { vibrate() {}, share() { return Promise.resolve(); }, clipboard: { writeText() { return Promise.resolve(); } } },
  confirm: () => true, alert() {}, document: doc, localStorage: { getItem: () => JSON.stringify(state), setItem() {}, removeItem() {} }, window: {}, performance: { now: () => Date.now() } };
vm.createContext(ctx); vm.runInContext(SRC, ctx);
assert.equal(typeof ctx.orderTodayTasks, 'function', '需要独立的今日安排排序函数');
const ordered = ctx.orderTodayTasks(state.days[today].tasks);
assert.deepEqual(ordered.map(t => t.id), ['todo-early','todo-late','done-early','done-late']);
console.log('✓ 今日安排：未完成在前，已完成/跳过在末尾，组内按时间排序');
