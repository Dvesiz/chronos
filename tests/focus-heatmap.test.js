const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const SRC = fs.readFileSync('app/src/main/assets/www/app.js', 'utf8');
const doc = { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}, createElement: () => ({ style: { setProperty() {} }, appendChild() {}, classList: { add() {}, remove() {}, toggle() {} } }) };
const ctx = { console, Date, Math, JSON, Number, String, Array, Object, Promise, setTimeout, clearTimeout,
  navigator: { vibrate() {}, share() { return Promise.resolve(); }, clipboard: { writeText() { return Promise.resolve(); } } },
  confirm: () => true, alert() {}, document: doc, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, window: {}, performance: { now: () => Date.now() } };
vm.createContext(ctx); vm.runInContext(SRC, ctx);
assert.equal(typeof ctx.aggregateFocusHeatmap, 'function', '需要专注热力图聚合函数');
const a = new Date(2026, 10, 16, 9, 15).getTime(); // Monday 09:00 local
const b = new Date(2026, 10, 16, 9, 45).getTime();
const c = new Date(2026, 10, 17, 22, 0).getTime();
const result = ctx.aggregateFocusHeatmap({
  '2026-11-16': [{ sessionId: 'a', start: a, end: a + 1800 * 1000, seconds: 1800 }],
  '2026-11-17': [{ sessionId: 'b', start: c, end: c + 600 * 1000, seconds: 600 }, { sessionId: 'b', start: c, end: c + 600 * 1000, seconds: 600 }]
});
assert.equal(result[0][9], 1800, '热力图应按本地星期/小时聚合专注秒数');
assert.equal(result[1][22], 600, '重复 session 不应双计');
assert.equal(result.flat().reduce((x, n) => x + n, 0), 2400);
console.log('✓ 专注热力图：按星期×小时聚合且去重 session');
