// 数据丢失事故回归测试。
//
// 真实事故：安卓上做了几小时的操作 → 之后用浏览器登录 → 浏览器端没同步到
// 安卓的新数据，反而用浏览器里的旧数据整份覆盖了云端 → 安卓下次轮询拉到
// 旧数据，新操作全部丢失。
//
// 根因有两层，本测试分别锁住：
//  1. 客户端登录时提供「保留本机数据并上传」的分支，会用全量 replace 覆盖云端；
//  2. 服务端不拒绝非首传的全量 replace。
//
// 新契约（故意不对称，偏向保护云端已有数据）：
//  - 云端有数据 → 客户端一律以云端为准，绝不上传本地；
//  - 云端为空   → 才允许本地全量上传；
//  - 服务端 head_seq > 0 时拒绝整份 replace；
//  - 云端覆盖本地前先备份本地快照。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const CLIENT = fs.readFileSync('app/src/main/assets/www/cloud-sync.js', 'utf8');
const SERVER = fs.readFileSync('backend/src/index.js', 'utf8');

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function createHarness(fetchImpl, { session = true } = {}) {
  const values = new Map();
  const intervals = [];
  const listeners = {};
  const localStorage = {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
  if (session) values.set('chronos.cloud.session.v1', JSON.stringify({ accessToken: 'access', refreshToken: 'refresh' }));
  const document = { hidden: false, addEventListener: (n, cb) => { listeners['document:' + n] = cb; } };
  const window = {
    CHRONOS_API_BASE: 'https://api.example',
    localStorage,
    AbortController,
    crypto: { randomUUID: () => 'event-' + Math.random() },
    confirm: () => false,          // 浏览器/WebView 里用户点「取消」
    addEventListener: (n, cb) => { listeners[n] = cb; },
    setInterval: (cb, ms) => { intervals.push({ callback: cb, ms }); return intervals.length; },
    setTimeout, clearTimeout
  };
  vm.runInNewContext(CLIENT, {
    window, document, localStorage, fetch: fetchImpl,
    AbortController, crypto: window.crypto, setTimeout, clearTimeout, console,
    setInterval: window.setInterval, clearInterval: () => {}
  });
  return { api: window.ChronosCloud, intervals, listeners, values };
}

const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const tick = () => new Promise(r => setImmediate(r));

(async () => {
  // ---------- 1. 登录时云端有数据：本地不得覆盖云端 ----------
  {
    let posted = null;
    const remoteState = { days: { '2026-11-13': { tasks: [{ id: 'new', title: '安卓新记录' }] } } };
    const harness = createHarness(async (url, options = {}) => {
      const u = String(url);
      if (u.includes('/v1/auth/verify')) return response({ accessToken: 'a', refreshToken: 'r', user: { email: 'u@e.com' } });
      if (u.includes('/v1/sync/snapshot')) return response({ state: remoteState, headSeq: 42 });
      if (u.includes('/v1/sync/events')) { posted = options.body; return response({ accepted: [], headSeq: 42, state: remoteState }); }
      if (u.includes('/v1/sync/head')) return response({ headSeq: 42 });
      throw new Error('unexpected ' + u);
    }, { session: false });

    // 浏览器本地是几小时前的旧数据
    let local = { days: { '2026-11-13': { tasks: [{ id: 'old', title: '浏览器旧记录' }] } } };
    harness.api.init({ get: () => local, apply: s => { local = s; } });

    await harness.api.verify('user@example.com', '123456');
    await tick();

    assert.deepEqual(
      JSON.parse(JSON.stringify(local.days['2026-11-13'].tasks.map(t => t.id))),
      ['new'],
      '登录后本地必须变成云端数据（不能保留浏览器的旧记录）'
    );
    assert.equal(posted, null,
      '云端已有数据时，登录不得上传任何事件（尤其不能是整份 replace）');
    console.log('✓ 登录对齐：云端有数据时本地服从云端，不上传覆盖');
  }

  // ---------- 2. 云端为空：允许把本地数据抬上去 ----------
  {
    let uploadedOps = null;
    const harness = createHarness(async (url, options = {}) => {
      const u = String(url);
      if (u.includes('/v1/auth/verify')) return response({ accessToken: 'a', refreshToken: 'r', user: { email: 'u@e.com' } });
      if (u.includes('/v1/sync/snapshot')) return response({ state: { days: {} }, headSeq: 0 });
      if (u.includes('/v1/sync/events')) {
        const body = JSON.parse(options.body);
        uploadedOps = body.events[0].ops;
        return response({ accepted: [{ eventId: body.events[0].eventId }], headSeq: 1, state: { days: { x: 1 } } });
      }
      if (u.includes('/v1/sync/head')) return response({ headSeq: 1 });
      throw new Error('unexpected ' + u);
    }, { session: false });

    let local = { days: { '2026-11-13': { tasks: [{ id: 'mine' }] } } };
    harness.api.init({ get: () => local, apply: s => { local = s; } });
    await harness.api.verify('user@example.com', '123456');
    await tick();

    assert.ok(uploadedOps, '云端为空时应上传本地数据');
    assert.equal(uploadedOps[0].op, 'replace', '首次上传用整份 replace');
    console.log('✓ 首次上传：云端为空时才允许整份 replace');
  }

  // ---------- 3. 服务端拒绝非首传的全量 replace ----------
  {
    assert.ok(/replace_forbidden/.test(SERVER), '服务端应有 replace_forbidden 守卫');
    assert.ok(/head_seq \|\| 0\) > 0[\s\S]{0,400}?replace/.test(SERVER),
      '守卫条件应是「云端已有数据时禁止整份 replace」');
    console.log('✓ 服务端守卫：head_seq > 0 时拒绝整份覆盖');
  }

  // ---------- 4. 覆盖前备份本地 ----------
  {
    let local = { days: { '2026-11-01': { tasks: [{ id: 'keep-me' }] } } };
    const harness = createHarness(async (url) => {
      const u = String(url);
      if (u.includes('/v1/sync/snapshot')) return response({ state: { days: { '2026-11-13': { tasks: [] } } }, headSeq: 7 });
      if (u.includes('/v1/sync/head')) return response({ headSeq: 7 });
      if (u.includes('/v1/sync/events')) return response({ accepted: [], headSeq: 7, state: {} });
      throw new Error('unexpected ' + u);
    });

    harness.api.init({ get: () => local, apply: s => { local = s; } });
    await tick(); await tick();

    const backupRaw = harness.values.get('chronos.state.before-cloud-sync');
    assert.ok(backupRaw, '云端覆盖本地前应写入本地备份');
    const backup = JSON.parse(backupRaw);
    assert.ok(backup.state.days['2026-11-01'], '备份必须包含被覆盖前的本地数据');
    assert.equal(backup.reason, 'boot', '备份应记录覆盖原因');
    console.log('✓ 本地保护：覆盖前留快照，可事后恢复');
  }

  console.log('\n全部通过：登录/启动不再用旧本地覆盖云端');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
