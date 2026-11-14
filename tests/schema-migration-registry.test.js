const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const SRC = fs.readFileSync('app/src/main/assets/www/app.js', 'utf8');
const doc = { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}, createElement: () => ({ style: { setProperty() {} }, appendChild() {}, classList: { add() {}, remove() {}, toggle() {} } }) };
const ctx = { console, Date, Math, JSON, Number, String, Array, Object, Promise, setTimeout, clearTimeout,
  navigator: { vibrate() {}, share() { return Promise.resolve(); }, clipboard: { writeText() { return Promise.resolve(); } } },
  confirm: () => true, alert() {}, document: doc, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, window: {}, performance: { now: () => Date.now() } };
vm.createContext(ctx); vm.runInContext(SRC, ctx);
assert.equal(typeof ctx.migrateState, 'function', '需要可调用的状态迁移入口');
assert.ok(ctx.STATE_MIGRATIONS && typeof ctx.STATE_MIGRATIONS === 'object', '需要版本迁移注册表');
const migrated = ctx.migrateState({ schemaVersion: 1, days: {}, template: [] });
assert.equal(migrated.schemaVersion, 3, '旧状态应逐版本迁移到当前版本');
const twice = ctx.migrateState(migrated);
assert.deepEqual(JSON.parse(JSON.stringify(twice)), JSON.parse(JSON.stringify(migrated)), '迁移必须幂等');
const future = ctx.migrateState({ schemaVersion: 99, days: { keep: true } });
assert.equal(future.schemaVersion, 99, '未来版本不能被当前客户端降级');
console.log('✓ schema migration registry：顺序迁移、幂等、未来版本保护');
