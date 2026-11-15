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
      if (postCount === 1) return response({
        accepted: [],
        results: [{
          eventId: JSON.parse(options.body).events[0].eventId,
          status: 'rejected',
          error: 'stale_revision',
          currentRevision: 2
        }],
        headSeq: 2,
        revision: 2,
        state: { remote: 2 }
      });
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

  // 旧版本已经把 stale_revision 事件持久化成 rejected 时，升级后也必须自动恢复。
  {
    const values = new Map([
      ['chronos.cloud.session.v1', JSON.stringify({ accessToken: 'a', refreshToken: 'r', user: { id: 'account-a' } })],
      ['chronos.cloud.queue.v1.v2.account-a', JSON.stringify([{
        eventId: 'legacy-stale', deviceId: 'device-a', accountScope: 'account-a', baseSeq: 1, baseRevision: 1,
        status: 'rejected', error: 'stale_revision', ops: [{ op: 'set', path: ['local'], value: 1 }], queuedAt: 1, clientAt: 1
      }])]
    ]);
    const localStorage = {
      getItem: key => values.get(key) || null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: key => values.delete(key)
    };
    let current = { local: 1 };
    let postCount = 0;
    const window = {
      CHRONOS_API_BASE: 'https://api.example', localStorage,
      AbortController, crypto: { randomUUID: () => 'legacy-retry' },
      addEventListener: () => {}, setInterval: () => 1, setTimeout, clearTimeout
    };
    const document = { hidden: false, addEventListener: () => {} };
    vm.runInNewContext(SOURCE, {
      window, document, localStorage,
      fetch: async (url, options = {}) => {
        const path = String(url);
        if (path.includes('/v1/sync/snapshot')) return response({ state: { remote: 2 }, headSeq: 2, revision: 2 });
        if (path.includes('/v1/sync/events')) {
          postCount++;
          const event = JSON.parse(options.body).events[0];
          return response({ accepted: [{ eventId: event.eventId }], headSeq: 3, revision: 3, state: { remote: 2, local: 1 } });
        }
        if (path.includes('/v1/sync/ack')) return response({ ok: true });
        throw new Error('unexpected request ' + path);
      },
      AbortController, crypto: window.crypto, setTimeout, clearTimeout, console
    });
    window.ChronosCloud.init({ get: () => current, apply: next => { current = next; } });
    for (let i = 0; i < 8 && postCount < 1; i++) await tick();
    assert.equal(postCount, 1, '升级后旧 stale_revision 队列必须自动恢复并上传');
    const stored = JSON.parse(values.get('chronos.cloud.queue.v1.v2.account-a') || '[]');
    assert.equal(stored.length, 0, '成功上传后旧 rejected 事件必须从队列移除');
    console.log('✓ legacy stale_revision：升级后自动恢复旧 rejected 队列');
  }

  // 启动时已有本地待上传队列：初始快照返回的 revision 必须成为下一次上传基线。
  {
    const values = new Map([
      ['chronos.cloud.session.v1', JSON.stringify({ accessToken: 'a', refreshToken: 'r', user: { id: 'account-a' } })],
      ['chronos.cloud.queue.v1.v2.account-a', JSON.stringify([{
        eventId: 'startup-pending', deviceId: 'device-a', accountScope: 'account-a', baseSeq: 3, baseRevision: 3,
        ops: [{ op: 'set', path: ['local'], value: 1 }], queuedAt: 1, clientAt: 1
      }])]
    ]);
    const localStorage = {
      getItem: key => values.get(key) || null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: key => values.delete(key)
    };
    const posted = [];
    const window = {
      CHRONOS_API_BASE: 'https://api.example', localStorage,
      AbortController, crypto: { randomUUID: () => 'startup-retry' },
      addEventListener: () => {}, setInterval: () => 1, setTimeout, clearTimeout
    };
    const document = { hidden: false, addEventListener: () => {} };
    vm.runInNewContext(SOURCE, {
      window, document, localStorage,
      fetch: async (url, options = {}) => {
        const path = String(url);
        if (path.includes('/v1/sync/snapshot')) return response({ state: { remote: 1 }, headSeq: 4, revision: 4 });
        if (path.includes('/v1/sync/events')) {
          const body = JSON.parse(options.body);
          posted.push(body);
          return response({ accepted: body.events.map(event => ({ eventId: event.eventId })), headSeq: 5, revision: 5, state: { remote: 1, local: 1 } });
        }
        if (path.includes('/v1/sync/ack')) return response({ ok: true });
        throw new Error('unexpected request ' + path);
      },
      AbortController, crypto: window.crypto, setTimeout, clearTimeout, console
    });
    let current = { local: 1 };
    window.ChronosCloud.init({ get: () => current, apply: next => { current = next; } });
    for (let i = 0; i < 8 && posted.length < 1; i++) await tick();
    assert.equal(posted.length, 1, '启动时已有队列应在快照对账后上传');
    assert.equal(posted[0].baseRevision, 4, '启动快照 revision 必须成为上传基线');
    assert.equal(posted[0].events[0].baseRevision, 4, '事件也必须使用启动快照 revision');
    console.log('✓ 启动对账：使用云端 revision 作为上传基线');
  }
})().catch(error => { console.error('FAILED:', error.message); process.exit(1); });
