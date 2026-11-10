// 番茄钟「正向计时」回归测试。
//
// 需求：番茄钟除了经典倒计时（25/5），还要支持正向计时——
// 从 00:00 开始累加，不设上限，用户手动结束时把实际专注时长计入当天。
//
// 关键不变量：
//  1. 正向模式不自动结束（不会到点触发 pomoFinish）
//  2. 暂停 / 继续后累计时长不丢
//  3. 结束时计入当天专注时长（会出现在番茄记录里）
//  4. 倒计时模式行为完全不变
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const SRC = fs.readFileSync('app/src/main/assets/www/app.js', 'utf8');

function makeEl(id) {
  return {
    id, innerHTML: '', dataset: {}, style: {}, value: '', checked: true, textContent: '',
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) this._s.add(c); else this._s.delete(c); },
      contains(c) { return this._s.has(c); }
    },
    setAttribute() {}, appendChild() {}, remove() {},
    addEventListener() {},
    querySelector: () => makeEl('child'),
    querySelectorAll: () => [],
    closest() { return { classList: this.classList }; }
  };
}

const elements = new Map();
const getEl = sel => { if (!elements.has(sel)) elements.set(sel, makeEl(sel)); return elements.get(sel); };

const document = {
  querySelector: getEl,
  querySelectorAll: () => [],
  addEventListener() {},
  createElement: () => makeEl('created'),
  body: { contains: () => true, classList: makeEl('body').classList },
  hidden: false
};

const store = { 'chronos.state.v1': JSON.stringify({ template: [], days: {}, pomo: { sessions: {} } }) };
const ctx = {
  console, Date, Math, JSON, Number, String, Array, Object, Promise,
  setTimeout: () => 1, clearTimeout() {},
  navigator: { vibrate() {}, share: () => Promise.resolve(), clipboard: { writeText: () => Promise.resolve() } },
  confirm: () => true, alert() {},
  document,
  localStorage: {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; }
  },
  window: {},
  performance: { now: () => Date.now() }
};
vm.createContext(ctx);
vm.runInContext(SRC, ctx);

// 屏蔽会触碰 DOM/原生能力的副作用
['renderFocus', 'renderHome', 'refreshStats', 'renderImmerse', 'openImmerse', 'closeImmerse',
 'syncGuard', 'haptic', 'toast', 'save', 'updateGuardRow', 'renderPomoBars', 'moveGlider',
 'checkMilestones', 'settleStaleTimers', 'ensureToday', 'tickPomo'].forEach(n => { ctx[n] = () => {}; });

const state = () => vm.runInContext('state', ctx);
const todayK = vm.runInContext('todayKey()', ctx);
const run = expr => vm.runInContext(expr, ctx);

// --- 需求 1：正向模式存在，且不自动结束 --------------------------------

// 切到正向计时
assert.equal(typeof run('setPomoMode'), 'function', '应有 setPomoMode() 用于切换模式');
run("setPomoMode('up')");
assert.equal(state().pomo.mode, 'up', '切换后 mode 应为 up');

// 正向模式：初始显示 0
assert.equal(run('pomoTotal()'), 0, '正向模式总时长应为 0（无上限）');
assert.equal(run('pomoRemain()'), 0, '未开始时剩余/已计为 0');

// 开始计时：正向模式不能用「剩余时间」语义，应记录开始时刻
const t0 = Date.now();
state().pomo.running = true;
state().pomo.startAt = t0 - 65 * 1000;   // 模拟已跑 65 秒
state().pomo.endAt = null;

const elapsed = run('pomoElapsed()');
assert.ok(elapsed >= 64 && elapsed <= 67, `正向模式已计时长应约 65 秒，实际 ${elapsed}`);

// 正向模式绝不自动结束
run('tickPomo()');
assert.equal(state().pomo.running, true, '正向模式不应因到点自动结束');

// --- 需求 2：暂停 / 继续不丢时长 ---------------------------------------
state().pomo.remain = run('pomoElapsed()');
state().pomo.running = false;
state().pomo.startAt = null;
const held = state().pomo.remain;
assert.ok(held >= 64, '暂停后应保留已计时长');

state().pomo.running = true;
state().pomo.startAt = Date.now() - (held + 10) * 1000;
const resumed = run('pomoElapsed()');
assert.ok(resumed >= held + 9, '继续后应在原时长上累加');

// --- 需求 3：结束后计入当天 ---------------------------------------------
state().pomo.running = false;
state().pomo.startAt = Date.now() - 120 * 1000;
state().pomo.remain = 120;
state().days[todayK] = { tasks: [], partialFocus: [] };
const counted = run('finishPomoEarly()');
assert.ok(counted >= 118, `结束后应返回并计入实际时长，实际 ${counted}`);
const day = state().days[todayK];
const totalCounted = (day.partialFocus || []).reduce((a, x) => a + (x.seconds || 0), 0)
  + (day.tasks || []).reduce((a, t) => a + (t.pomoAcc || 0), 0);
assert.ok(totalCounted >= 118, '实际时长应写入当天记录');

// --- 需求 4：切回倒计时，行为不变 --------------------------------------
run("setPomoMode('down')");
assert.equal(state().pomo.mode, 'down', '应能切回倒计时');
assert.equal(run('pomoTotal()'), 25 * 60, '25/5 预设下总时长仍为 1500 秒');
assert.equal(run('pomoElapsed()'), 0, '倒计时刚开始已计为 0');

state().pomo.running = true;
state().pomo.endAt = Date.now() + 600 * 1000;   // 剩余 10 分钟
state().pomo.remain = 600;
assert.equal(run('pomoTotal()'), 1500, '倒计时总时长不变');
const downElapsed = run('pomoElapsed()');
assert.ok(downElapsed >= 899 && downElapsed <= 901, `倒计时已过应约 900 秒，实际 ${downElapsed}`);

console.log('✓ 番茄钟正向计时：不自动结束、暂停续计、结束计入当天；倒计时行为不变');
