const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const SRC = fs.readFileSync('app/src/main/assets/www/app.js', 'utf8');
const store = { 'chronos.state.v1': JSON.stringify({ template: [], days: {}, pomo: { sessions: {} } }) };
const toastCalls = [];
const doc = { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}, createElement: () => ({ style: { setProperty() {} }, appendChild() {}, classList: { add() {}, remove() {}, toggle() {} } }) };
const ctx = { console, Date, Math, JSON, Number, String, Array, Object, Promise, setTimeout, clearTimeout,
  navigator: { vibrate() {}, share() { return Promise.resolve(); }, clipboard: { writeText() { return Promise.resolve(); } } },
  confirm: () => true, alert() {}, document: doc, localStorage: { getItem: k => store[k] || null, setItem: (k,v) => { store[k]=String(v); }, removeItem: k => delete store[k] }, window: {}, performance: { now: () => Date.now() } };
vm.createContext(ctx); vm.runInContext(SRC, ctx);
ctx.toast = message => toastCalls.push(message);
assert.equal(typeof ctx.saveBackupSnapshot, 'function', '需要多版本备份函数');
ctx.saveBackupSnapshot({ days: { a: 1 } }, 'test-1');
ctx.saveBackupSnapshot({ days: { b: 2 } }, 'test-2');
const backups = JSON.parse(store['chronos.state.backups.v1']);
assert.equal(backups.length, 2);
assert.equal(backups[0].reason, 'test-2');
assert.equal(backups[1].reason, 'test-1');
assert.equal(typeof backups[0].at, 'number');
console.log('✓ 多版本本地备份：按时间倒序保留历史快照');

const failCtx = { ...ctx, localStorage: { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem() {} } };
vm.createContext(failCtx); vm.runInContext(SRC, failCtx);
failCtx.toast = message => toastCalls.push(message);
failCtx.save(true);
assert.ok(toastCalls.some(message => /保存|存储|导出/.test(message)), '本地存储失败必须给出可见提示');
console.log('✓ 本地存储失败：用户可见提示');
