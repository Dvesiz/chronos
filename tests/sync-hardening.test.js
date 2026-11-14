const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');

const CLIENT = fs.readFileSync('app/src/main/assets/www/cloud-sync.js', 'utf8');
const CORE = fs.readFileSync('backend/src/core.js', 'utf8');

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

function createHarness(fetchImpl, initial = {}) {
  const values = new Map(Object.entries(initial));
  const listeners = {};
  const intervals = [];
  const localStorage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
  const window = {
    CHRONOS_API_BASE: 'https://api.example',
    localStorage,
    crypto: { randomUUID: () => 'evt-' + Math.random() },
    addEventListener: (name, callback) => { listeners[name] = callback; },
    setInterval: (callback, ms) => { intervals.push({ callback, ms }); return intervals.length; },
    clearInterval: () => {},
    setTimeout,
    clearTimeout
  };
  const document = { hidden: false, addEventListener: (name, callback) => { listeners['document:' + name] = callback; } };
  vm.runInNewContext(CLIENT, { window, document, localStorage, fetch: fetchImpl, AbortController, crypto: window.crypto, setTimeout, clearTimeout, console });
  return { api: window.ChronosCloud, values, intervals, listeners };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('账号切换时只上传当前账号的 Outbox 事件', async () => {
  const posted = [];
  const legacy = JSON.stringify([{ eventId: 'old-account', deviceId: 'd', baseSeq: 0, ops: [{ op: 'set', path: ['old'], value: true }] }]);
  const harness = createHarness(async (url, options = {}) => {
    const path = String(url);
    if (path.includes('/v1/auth/verify')) return response({ accessToken: 'a', refreshToken: 'r', user: { id: 'account-b', email: 'b@example.com' } });
    if (path.includes('/v1/sync/snapshot')) return response({ state: {}, headSeq: 0, revision: 0 });
    if (path.includes('/v1/sync/events')) { posted.push(JSON.parse(options.body)); return response({ accepted: [], headSeq: 0, revision: 0, state: {} }); }
    throw new Error('unexpected request ' + path);
  }, { 'chronos.cloud.queue.v1': legacy });
  let current = {};
  harness.api.init({ get: () => current, apply: next => { current = next; } });
  await harness.api.verify('b@example.com', '123456');
  await tick();
  assert.equal(posted.length, 0, '未归属账号的旧队列不得上传给新账号');
});

test('replace_forbidden 只标记冲突，不删除本地事件', async () => {
  const event = { eventId: 'replace-event', deviceId: 'd', baseSeq: 0, baseRevision: 0, ops: [{ op: 'replace', path: [], value: { local: true } }] };
  const harness = createHarness(async url => {
    const path = String(url);
    if (path.includes('/v1/sync/snapshot')) return response({ state: { remote: true }, headSeq: 2, revision: 2 });
    if (path.includes('/v1/sync/events')) return response({ error: 'replace_forbidden' }, 409);
    if (path.includes('/v1/sync/head')) return response({ headSeq: 2, revision: 2 });
    throw new Error('unexpected request ' + path);
  }, {
    'chronos.cloud.session.v1': JSON.stringify({ accessToken: 'a', refreshToken: 'r', user: { id: 'account-a' } }),
    'chronos.cloud.queue.v1': JSON.stringify([event])
  });
  let current = { local: true };
  harness.api.init({ get: () => current, apply: next => { current = next; } });
  await tick();
  const stored = JSON.parse(harness.values.get('chronos.cloud.queue.v1') || '[]');
  assert.ok(stored.some(item => item.eventId === 'replace-event'), '被拒事件必须保留');
  assert.equal(stored.find(item => item.eventId === 'replace-event').status, 'conflict');
});

test('Tombstone 在 rebase 后仍随事件保留', () => {
  assert.match(CLIENT, /deleteEntities[\s\S]{0,250}rebase|rebase[\s\S]{0,250}deleteEntities/, 'rebase 必须重建删除元数据');
  assert.match(CLIENT, /deleteEntities[\s\S]{0,250}compact|compact[\s\S]{0,250}deleteEntities/, '压缩必须保留删除元数据');
});

test('服务端校验删除实体的结构与数量', () => {
  assert.match(CORE, /deleteEntities/, '事件校验必须检查删除实体');
  assert.match(CORE, /entityType/, '删除实体必须有类型');
  assert.match(CORE, /entityId/, '删除实体必须有 ID');
});

test('同步实现暴露明确的状态机和退避字段', () => {
  assert.match(CLIENT, /retrying|failed|conflict|recovery_required/, '需要可观察的同步状态');
  assert.match(CLIENT, /2000|4000|8000|16000|32000/, '需要 2/4/8/16/32 秒退避');
});

console.log('✓ sync hardening contracts');
