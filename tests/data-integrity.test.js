// 数据完整性回归测试（三个 P0 隐患）。
//
// P0-1 离线队列溢出不能丢数据：旧实现 slice(-MAX_QUEUE) 硬截断，
//      连续离线 100 次以上最早的改动被静默丢弃。现在应塌缩成一条合并事件，
//      保证「最终状态」一定能传到云端。
//
// P0-2 服务端事件日志必须裁剪，否则 D1 无限膨胀。
//
// P0-3 120 天硬裁剪会删掉历史。旧实现直接 delete 第 121 天及更早的明细，
//      年度回顾做不了。现在应压缩成 state.summary 永久保留。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const SRC = fs.readFileSync('app/src/main/assets/www/cloud-sync.js', 'utf8');

function createHarness(fetchImpl) {
  const values = new Map();
  const intervals = [];
  const listeners = {};
  const localStorage = {
    getItem: k => (values.has(k) ? values.get(k) : null),
    setItem: (k, v) => values.set(k, String(v)),
    removeItem: k => values.delete(k)
  };
  values.set('chronos.cloud.session.v1', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }));
  const document = { hidden: false, addEventListener: (n, cb) => { listeners['document:' + n] = cb; } };
  const window = {
    CHRONOS_API_BASE: 'https://api.example',
    localStorage,
    AbortController,
    crypto: { randomUUID: () => 'e-' + Math.random() },
    confirm: () => true,
    addEventListener: (n, cb) => { listeners[n] = cb; },
    setInterval: (cb, ms) => { intervals.push({ callback: cb, ms }); return intervals.length; },
    setTimeout, clearTimeout
  };
  vm.runInNewContext(SRC, {
    window, document, localStorage, fetch: fetchImpl,
    AbortController, crypto: window.crypto, setTimeout, clearTimeout, console,
    setInterval: window.setInterval, clearInterval: () => {}
  });
  return { api: window.ChronosCloud, intervals, listeners, values };
}

const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const tick = () => new Promise(r => setImmediate(r));

(async () => {
  // ---------- P0-1：离线 150 次改动后，最终状态仍能上传 ----------
  {
    let current = { days: {} };
    let uploads = [];
    const harness = createHarness(async (url, options = {}) => {
      const u = String(url);
      if (u.includes('/v1/sync/head')) return response({ headSeq: 0 });
      if (u.includes('/v1/sync/snapshot')) return response({ state: { days: {} }, headSeq: 0 });
      if (u.includes('/v1/sync/events')) {
        // 模拟离线：全部失败，队列只增不减
        return response({ error: 'offline' }, 503);
      }
      throw new Error('unexpected ' + u);
    });

    harness.api.init({ get: () => current, apply: s => { current = s; } });
    await tick();

    // 连续 150 次修改（远超 MAX_QUEUE=100）
    for (let i = 1; i <= 150; i++) {
      current = { days: { '2026-11-13': { tasks: [{ id: 't', n: i }] } }, counter: i };
      harness.api.queueState(current);
    }

    const queued = JSON.parse(harness.values.get('chronos.cloud.queue.v1') || '[]');
    assert.ok(queued.length <= 100,
      `队列不应无限增长，实际 ${queued.length}`);

    // 关键：最终状态（counter=150）必须能被重放出来
    const applied = queued.reduce((acc, ev) => {
      (ev.ops || []).forEach(op => {
        if (op.op === 'set' && op.path.length === 1) acc[op.path[0]] = op.value;
        if (op.op === 'set' && op.path.length === 2 && op.path[0] === 'days') {
          acc.days = acc.days || {};
          acc.days[op.path[1]] = op.value;
        }
      });
      return acc;
    }, { days: {} });

    assert.equal(applied.counter, 150,
      '队列塌缩后必须保留最终状态（counter=150），不能丢成中间值');
    console.log('✓ P0-1 队列溢出：塌缩为合并事件，最终状态不丢');
  }

  // ---------- P0-2：服务端必须裁剪事件日志 ----------
  {
    const SERVER = fs.readFileSync('backend/src/index.js', 'utf8');
    assert.ok(/MAX_EVENTS_PER_USER/.test(SERVER), '应定义事件日志上限');
    assert.ok(/DELETE FROM sync_events WHERE user_id=\? AND server_seq<=\?/.test(SERVER),
      '应在写入后按 server_seq 裁剪旧日志');
    assert.ok(/serverSeq - MAX_EVENTS_PER_USER/.test(SERVER),
      '裁剪边界应为「当前序号 - 保留条数」');
    console.log('✓ P0-2 事件日志：写入后按上限裁剪，D1 不再无限膨胀');
  }

  // ---------- P0-3：超窗数据压成汇总，不直接删除 ----------
  {
    const APP = fs.readFileSync('app/src/main/assets/www/app.js', 'utf8');
    assert.ok(/function compactDays/.test(APP), '应有 compactDays()');
    assert.ok(/state\.summary\[k\] = \{/.test(APP), '应把超窗日期写入 state.summary');
    assert.ok(/delete state\.days\[k\]/.test(APP), '写入汇总后再删除明细');
    // 旧的一刀切写法必须消失
    assert.ok(!/while \(keys\.length > 120\) delete state\.days\[keys\.shift\(\)\]/.test(APP),
      '不应再保留「超过 120 天直接删除」的旧写法');
    assert.ok(/DETAIL_DAYS/.test(APP), '应有明细窗口常量');

    // 用真实 app.js 验证：150 天数据裁剪后仍留汇总
    const store = { 'chronos.state.v1': JSON.stringify({ template: [], days: {}, pomo: { sessions: {} } }) };
    const doc = {
      querySelector: () => null, querySelectorAll: () => [],
      addEventListener: () => {}, createElement: () => ({ style: { setProperty() {} }, appendChild() {}, classList: { add() {}, remove() {}, toggle() {} } }),
      body: { contains: () => true, classList: { add() {}, remove() {} } }, hidden: false
    };
    const ctx = {
      console, Date, Math, JSON, Number, String, Array, Object, Promise,
      setTimeout: () => 1, clearTimeout() {},
      navigator: { vibrate() {}, share: () => Promise.resolve(), clipboard: { writeText: () => Promise.resolve() } },
      confirm: () => true, alert() {}, document: doc,
      localStorage: {
        getItem: k => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: k => { delete store[k]; }
      },
      window: {}, performance: { now: () => Date.now() }
    };
    vm.createContext(ctx);
    vm.runInContext(APP, ctx);
    ['syncNative', 'queueCloudSync', 'renderHome', 'refreshStats'].forEach(n => { ctx[n] = () => {}; });

    // 造 150 天数据
    const days = {};
    const base = new Date('2026-11-13T12:00:00');
    for (let i = 0; i < 150; i++) {
      const d = new Date(base.getTime() - i * 86400000);
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      days[k] = { tasks: [{ id: k + ':a', title: 'x', subject: '学习', start: 540, end: 600, status: 'done', focusAcc: 1800, pomoAcc: 0, focusStart: null }] };
    }
    ctx.__setState = () => vm.runInContext('state', ctx);
    vm.runInContext(`state.days = ${JSON.stringify(days)}; state.summary = {}; compactDays();`, ctx);
    const after = vm.runInContext('state', ctx);
    assert.equal(Object.keys(after.days).length, 120, '明细应保留 120 天');
    assert.equal(Object.keys(after.summary).length, 30, '超出的 30 天应压成汇总');
    const one = after.summary[Object.keys(after.summary)[0]];
    assert.ok(one && typeof one.actual === 'number' && one.total === 1,
      '汇总应包含实际时长与时段数，历史趋势仍可追溯');

    // 汇总必须能穿过 normalizeState（导入 / 云端下发都会走它），否则年度趋势白做
    const roundTrip = JSON.parse(JSON.stringify({ summary: after.summary, days: {}, template: [] }));
    const ctx2 = {
      console, Date, Math, JSON, Number, String, Array, Object, Promise,
      setTimeout: () => 1, clearTimeout() {},
      navigator: { vibrate() {}, share: () => Promise.resolve(), clipboard: { writeText: () => Promise.resolve() } },
      confirm: () => true, alert() {}, document: doc,
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      window: {}, performance: { now: () => Date.now() }
    };
    vm.createContext(ctx2);
    vm.runInContext(APP, ctx2);
    ctx2.__input = roundTrip;
    const normalized = vm.runInContext('normalizeState(__input)', ctx2);
    assert.ok(normalized.summary && Object.keys(normalized.summary).length === 30,
      'normalizeState 必须保留 summary，不能被丢弃');
    const sample = normalized.summary[Object.keys(normalized.summary)[0]];
    assert.equal(typeof sample.actual, 'number', 'summary 的 actual 应被规整为数字');
    console.log('✓ P0-3 历史保留：超窗日期压成每日汇总，不再直接删除');
  }

  console.log('\n全部通过：三个数据完整性隐患已修复');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
