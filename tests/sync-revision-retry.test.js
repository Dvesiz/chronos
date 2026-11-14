const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const SOURCE = fs.readFileSync('app/src/main/assets/www/cloud-sync.js', 'utf8');
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const tick = () => new Promise(r => setImmediate(r));

(async () => {
  const values = new Map();
  values.set('chronos.cloud.session.v1', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }));
  const intervals = [];
  const calls = [];
  const localStorage = {
    getItem: k => values.get(k) || null,
    setItem: (k, v) => values.set(k, String(v)),
    removeItem: k => values.delete(k)
  };
  const window = {
    CHRONOS_API_BASE: 'https://api.example', localStorage,
    AbortController, crypto: { randomUUID: () => 'event-' + Math.random() },
    addEventListener: () => {}, setTimeout, clearTimeout,
    setInterval: (callback, ms) => { intervals.push({ callback, ms }); return intervals.length; },
    clearInterval: () => {}
  };
  const document = { hidden: false, addEventListener: () => {} };
  let current = { local: 0 };
  let snapshotCount = 0;
  let postCount = 0;
  const fetchImpl = async (url, options = {}) => {
    const path = String(url);
    calls.push(path);
    if (path.includes('/v1/sync/head')) return response({ headSeq: 2, revision: 2 });
    if (path.includes('/v1/sync/snapshot')) {
      snapshotCount++;
      return snapshotCount === 1
        ? response({ state: { }, headSeq: 0, revision: 0 })
        : response({ state: { remote: 2 }, headSeq: 2, revision: 2 });
    }
    if (path.includes('/v1/sync/events')) {
      postCount++;
      if (postCount === 1) return response({ error: 'stale_revision', currentRevision: 2 }, 409);
      return response({ accepted: [{ eventId: JSON.parse(options.body).events[0].eventId }], headSeq: 3, revision: 3, state: { remote: 2, local: 1 } });
    }
    throw new Error('unexpected request ' + path);
  };
  vm.runInNewContext(SOURCE, {
    window, document, localStorage, fetch: fetchImpl, AbortController,
    crypto: window.crypto, setTimeout, clearTimeout, console
  });
  const applied = [];
  window.ChronosCloud.init({ get: () => current, apply: next => { current = next; applied.push(next); } });
  await tick();
  current = { local: 1 };
  window.ChronosCloud.queueState(current);
  for (let i = 0; i < 12 && postCount < 2; i++) await tick();
  assert.ok(postCount >= 2, 'stale_revision 后必须重新上传 rebase 后事件');
  assert.ok(applied.some(next => next.remote === 2 && next.local === 1), 'rebase 后应应用远程状态与本地修改的合并结果');
  console.log('✓ stale_revision：拉取新版本后自动 rebase 并重试，队列不停止');
})().catch(error => { console.error('FAILED:', error.message); process.exit(1); });
