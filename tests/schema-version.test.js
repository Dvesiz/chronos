const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const SRC = fs.readFileSync('app/src/main/assets/www/app.js', 'utf8');
const doc = { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}, createElement: () => ({ style: { setProperty() {} }, appendChild() {}, classList: { add() {}, remove() {}, toggle() {} } }) };
const input = { template: [], days: {}, pomo: { sessions: {} } };
const ctx = { console, Date, Math, JSON, Number, String, Array, Object, Promise, setTimeout, clearTimeout,
 navigator: { vibrate() {}, share() { return Promise.resolve(); }, clipboard: { writeText() { return Promise.resolve(); } } },
 confirm: () => true, alert() {}, document: doc, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, window: {}, performance: { now: () => Date.now() } };
vm.createContext(ctx); vm.runInContext(SRC, ctx);
const once = ctx.normalizeState(input);
assert.equal(once.schemaVersion, 2, 'normalized state must carry schemaVersion 2');
const twice = ctx.normalizeState(once);
assert.deepEqual(JSON.parse(JSON.stringify(twice)), JSON.parse(JSON.stringify(once)), 'schema migration must be idempotent');
console.log('✓ schemaVersion：旧状态幂等迁移到 v2');
