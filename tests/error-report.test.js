// 前端错误上报回归测试。
//
// 契约：
//  1. 未配置后端 或 未登录时，完全不上报（本地优先原则）；
//  2. 已登录时，uncaught / unhandledrejection 会走 /v1/feedback；
//  3. 同一错误在去重窗口内只上报一次；
//  4. 每次会话最多上报 MAX_REPORTS 条；
//  5. 上报自身出错绝不影响主流程；
//  6. 不采集用户内容，只上报错误信息 + 版本 + 页面。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const SRC = fs.readFileSync('app/src/main/assets/www/error-report.js', 'utf8');

function createHarness({ apiBase = 'https://api.example', session = true, fetchImpl } = {}) {
  const calls = [];
  const listeners = {};
  const store = new Map();
  if (session) store.set('chronos.cloud.session.v1', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }));
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k)
  };
  const window = {
    CHRONOS_API_BASE: apiBase,
    CHRONOS_APP_VERSION: '2.7.1',
    localStorage,
    addEventListener: (name, cb) => { listeners[name] = cb; }
  };
  const fetch = fetchImpl || (async (url, opts) => {
    calls.push({ url: String(url), body: opts && opts.body, keepalive: opts && opts.keepalive });
    return { ok: true, status: 201, json: async () => ({ ok: true }) };
  });
  vm.runInNewContext(SRC, {
    window, localStorage, fetch, location: { pathname: '/app/index.html' },
    Date, JSON, String, Number, Error, console
  });
  return { listeners, calls, api: window.ChronosReport, store };
}

(async () => {
  // ---------- 1. 未登录：不上报 ----------
  {
    const h = createHarness({ session: false });
    h.listeners['error']({ error: new Error('boom'), filename: 'app.js', lineno: 10 });
    await new Promise(r => setImmediate(r));
    assert.equal(h.calls.length, 0, '未登录时不应上报任何内容');
    assert.equal(h.api.enabled(), false, '未登录时 enabled() 应为 false');
    console.log('✓ 未登录：完全不上报（本地优先）');
  }

  // ---------- 2. 未配置后端：不上报 ----------
  {
    const h = createHarness({ apiBase: '', session: true });
    h.listeners['error']({ error: new Error('boom') });
    await new Promise(r => setImmediate(r));
    assert.equal(h.calls.length, 0, '未配置 API 时不应上报');
    console.log('✓ 未配置后端：不上报');
  }

  // ---------- 3. 已登录：uncaught 会上报，且字段正确 ----------
  {
    const h = createHarness();
    h.listeners['error']({
      error: new Error('Cannot read properties of undefined'),
      filename: 'app.js', lineno: 42, colno: 7
    });
    await new Promise(r => setImmediate(r));
    assert.equal(h.calls.length, 1, '应上报一次');
    const call = h.calls[0];
    assert.ok(call.url.endsWith('/v1/feedback'), '应打到 /v1/feedback');
    assert.equal(call.keepalive, true, '应使用 keepalive，保证崩溃时也能发出');
    const body = JSON.parse(call.body);
    assert.equal(body.kind, 'crash', 'kind 应为 crash');
    assert.equal(body.appVersion, '2.7.1', '应带上版本号');
    assert.ok(/Cannot read properties/.test(body.body), '应包含错误消息');
    assert.ok(/app\.js:42/.test(body.body), '应包含出错位置');
    console.log('✓ 已登录：uncaught 正确上报到 /v1/feedback');
  }

  // ---------- 4. 同一错误去重 ----------
  {
    const h = createHarness();
    const err = { error: new Error('same error'), filename: 'app.js', lineno: 1 };
    h.listeners['error'](err);
    h.listeners['error'](err);
    h.listeners['error'](err);
    await new Promise(r => setImmediate(r));
    assert.equal(h.calls.length, 1, '同一错误在去重窗口内只报一次');
    console.log('✓ 去重：同一错误只上报一次');
  }

  // ---------- 5. 限频：最多 5 条 ----------
  {
    const h = createHarness();
    for (let i = 0; i < 20; i++) {
      h.listeners['error']({ error: new Error('err-' + i), filename: 'app.js', lineno: i });
    }
    await new Promise(r => setImmediate(r));
    assert.equal(h.calls.length, 5, '每次会话最多上报 5 条');
    console.log('✓ 限频：每次会话最多 5 条，不会刷爆接口');
  }

  // ---------- 6. unhandledrejection ----------
  {
    const h = createHarness();
    h.listeners['unhandledrejection']({ reason: new Error('promise failed') });
    await new Promise(r => setImmediate(r));
    assert.equal(h.calls.length, 1, '未处理的 Promise 拒绝也应上报');
    const body = JSON.parse(h.calls[0].body);
    assert.ok(/promise failed/.test(body.body), '应包含拒绝原因');
    assert.ok(/unhandledrejection/.test(body.body), '应标明类型');
    console.log('✓ unhandledrejection 也能捕获并上报');
  }

  // ---------- 7. 上报自身失败不影响主流程 ----------
  {
    const h = createHarness({ fetchImpl: async () => { throw new Error('network down'); } });
    assert.doesNotThrow(() => h.listeners['error']({ error: new Error('x') }));
    await new Promise(r => setImmediate(r));
    console.log('✓ 上报失败被静默吞掉，不影响主流程');
  }

  // ---------- 8. 不采集用户内容 ----------
  {
    const h = createHarness();
    h.listeners['error']({ error: new Error('err'), filename: 'app.js', lineno: 1 });
    await new Promise(r => setImmediate(r));
    const body = JSON.parse(h.calls[0].body);
    assert.ok(!/chronos\.state|days|tasks|localStorage/i.test(body.body),
      '不得上报用户学习数据');
    console.log('✓ 隐私：只上报错误信息，不采集用户数据');
  }

  // ---------- 9. CI 配置完整性 ----------
  {
    const wf = fs.readFileSync('.github/workflows/release.yml', 'utf8');
    assert.ok(/tags:/.test(wf) && /'v\*'/.test(wf), '应对 v* tag 触发');
    assert.ok(/AndroidManifest\.xml/.test(wf), '应从 manifest 读版本号');
    assert.ok(/tag 与 manifest 版本一致|Verify tag matches/.test(wf), '应校验 tag 与 manifest 版本一致');
    assert.ok(/CHRONOS_KEYSTORE_B64/.test(wf), '应从 secret 恢复签名证书');
    assert.ok(/softprops\/action-gh-release/.test(wf), '应自动上传 Release');
    assert.ok(/npm run test:all/.test(wf), '发版前应跑测试');
    console.log('✓ CI：tag 触发 / 版本校验 / 签名 / 自动上传 / 测试门禁');
  }

  console.log('\n全部通过：错误上报与 CI 发版配置均符合契约');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
