import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../app/src/main/assets/www/cloud-sync.js', import.meta.url), 'utf8');

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function createHarness(fetchImpl, { session = true, indexedDB } = {}) {
  const values = new Map();
  const intervals = [];
  const listeners = {};
  const localStorage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
  if (session) values.set('chronos.cloud.session.v1', JSON.stringify({ accessToken: 'access', refreshToken: 'refresh' }));
  const document = { hidden: false, addEventListener: (name, callback) => { listeners[`document:${name}`] = callback; } };
  const window = {
    CHRONOS_API_BASE: 'https://api.example',
    indexedDB,
    localStorage,
    AbortController,
    crypto: { randomUUID: () => `event-${Math.random()}` },
    confirm: () => true,
    addEventListener: (name, callback) => { listeners[name] = callback; },
    setInterval: (callback, ms) => { intervals.push({ callback, ms }); return intervals.length; },
    setTimeout,
    clearTimeout
  };
  vm.runInNewContext(source, { window, document, localStorage, fetch: fetchImpl, AbortController, crypto: window.crypto, setTimeout, clearTimeout, console });
  return { api: window.ChronosCloud, intervals, listeners, values };
}

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('concurrent expired requests share a single rotating refresh', async () => {
  const gate = deferred();
  let refreshes = 0;
  const harness = createHarness(async (url, options) => {
    if (url.endsWith('/v1/auth/refresh')) {
      const attempt = ++refreshes;
      await gate.promise;
      return attempt === 1 ? response({ accessToken: 'next', refreshToken: 'rotated' })
        : response({ error: 'refresh_invalid' }, 401);
    }
    return options.headers.authorization === 'Bearer next'
      ? response({ ok: true }) : response({ error: 'unauthorized' }, 401);
  });
  const results = Promise.allSettled([harness.api.devices(), harness.api.devices()]);
  await tick();
  gate.resolve();
  assert.deepEqual((await results).map(result => result.status), ['fulfilled', 'fulfilled']);
  assert.equal(refreshes, 1);
});

test('an acknowledged upload applies the server state before advancing past it', async () => {
  let current = { task: 0, timer: false };
  const harness = createHarness(async (url, options) => {
    if (url.endsWith('/snapshot')) return response({ state: current, headSeq: 1, revision: 1 });
    if (url.endsWith('/events')) {
      const [event] = JSON.parse(options.body).events;
      return response({ accepted: [{ eventId: event.eventId }], state: { task: 1, timer: true }, headSeq: 3, revision: 3 });
    }
    return response({ ok: true });
  });
  harness.api.init({ get: () => current, apply: next => { current = next; } });
  await tick();
  current.task = 1;
  harness.api.queueState(current);
  await tick();
  assert.equal(current.task, 1);
  assert.equal(current.timer, true, 'the remote edit cannot be skipped just because the upload advanced the cursor');
});

test('startup waits for IndexedDB edits before applying a cloud snapshot', async () => {
  const opening = {};
  const read = {};
  const applied = [];
  let current = { local: 1 };
  const harness = createHarness(async (url, options) => {
    if (url.endsWith('/snapshot')) return response({ state: { remote: 1 }, headSeq: 2, revision: 2 });
    if (url.endsWith('/events')) {
      const [event] = JSON.parse(options.body).events;
      return response({ accepted: [{ eventId: event.eventId }], state: { remote: 1, local: 1 }, headSeq: 3, revision: 3 });
    }
    return response({ ok: true });
  }, { indexedDB: { open: () => opening } });
  harness.api.init({ get: () => current, apply: next => { current = next; applied.push(next); } });
  await tick();
  const beforeHydration = current.local;
  opening.result = { transaction: mode => ({ objectStore: () => ({ getAll: () => read }) }) };
  opening.onsuccess();
  await tick();
  read.result = [{ eventId: 'offline', deviceId: 'd', ops: [{ op: 'set', path: ['local'], value: 1 }] }];
  read.onsuccess();
  await tick();
  assert.equal(beforeHydration, 1, 'startup cannot show a cloud-only snapshot before queue recovery');
  assert.ok(applied.length && applied.every(next => next.local === 1));
  assert.equal(current.remote, 1);
});

test('starts continuous polling after login during the current app session', async () => {
  let current = { value: 0 };
  let remote = { value: 0 };
  let remoteSeq = 0;
  let verifyCalls = 0;
  const harness = createHarness(async (url, options = {}) => {
    const path = String(url);
    if (path.includes('/v1/auth/verify')) {
      verifyCalls++;
      return response({ accessToken: 'access', refreshToken: 'refresh', user: { email: 'user@example.com' } });
    }
    if (path.includes('/v1/sync/snapshot')) return response({ state: remote, headSeq: remoteSeq });
    if (path.includes('/v1/sync/events')) {
      const events = JSON.parse(options.body || '{}').events || [];
      return response({ accepted: events.map(event => ({ eventId: event.eventId })), headSeq: remoteSeq, state: remote });
    }
    if (path.includes('/v1/sync/head')) return response({ headSeq: remoteSeq });
    throw new Error(`unexpected request ${url}`);
  }, { session: false });
  harness.api.init({ get: () => current, apply: state => { current = state; } });
  assert.equal(harness.intervals.length, 0, 'no polling should run before login');

  await harness.api.verify('user@example.com', '123456');
  assert.equal(verifyCalls, 1);
  const poll = harness.intervals.find(timer => timer.ms <= 10000);
  assert.ok(poll, 'login should start periodic sync polling');

  remote = { value: 1 };
  remoteSeq = 1;
  poll.callback();
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(current)), { value: 1 });
});

test('applies timeout protection to token refresh and retried requests', async () => {
  const signals = [];
  let calls = 0;
  const harness = createHarness(async (url, options = {}) => {
    signals.push(options.signal);
    calls++;
    if (calls === 1) return response({ error: 'unauthorized' }, 401);
    if (calls === 2) return response({ accessToken: 'next-access', refreshToken: 'next-refresh' });
    return response({ release: null });
  });
  await harness.api.latest();
  assert.equal(calls, 3);
  assert.ok(signals.every(Boolean), 'initial, refresh, and retry requests need abort signals');
});

test('polls snapshots and applies changes made by another device', async () => {
  let remote = { value: 1 };
  let remoteSeq = 1;
  let snapshots = 0;
  const applied = [];
  let current = { value: 0 };
  const harness = createHarness(async url => {
    if (String(url).includes('/v1/sync/head')) return response({ headSeq: remoteSeq });
    if (String(url).includes('/v1/sync/snapshot')) {
      snapshots++;
      return response({ state: remote, headSeq: remoteSeq });
    }
    throw new Error(`unexpected request ${url}`);
  });
  harness.api.init({ get: () => current, apply: state => { current = state; applied.push(state); } });
  await tick();
  assert.equal(snapshots, 1);
  assert.ok(harness.intervals.some(timer => timer.ms <= 10000), 'a periodic sync poll should be scheduled');

  remote = { value: 2 };
  remoteSeq = 2;
  harness.intervals.find(timer => timer.ms <= 10000).callback();
  await tick();
  assert.equal(snapshots, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(applied.at(-1))), { value: 2 });
});

test('rebases pending local edits onto a newer remote snapshot', async () => {
  let remote = { remote: 1 };
  let remoteSeq = 1;
  let posts = 0;
  let current = {};
  const harness = createHarness(async (url, options = {}) => {
    if (String(url).includes('/v1/sync/head')) return response({ headSeq: remoteSeq });
    if (String(url).includes('/v1/sync/snapshot')) return response({ state: remote, headSeq: remoteSeq });
    if (String(url).includes('/v1/sync/events')) {
      posts++;
      if (posts === 1) return response({ error: 'offline' }, 503);
      return response({ accepted: [{ eventId: JSON.parse(options.body).events[0].eventId }], headSeq: 3, state: { remote: 2, local: 1 } });
    }
    throw new Error(`unexpected request ${url}`);
  });
  harness.api.init({ get: () => current, apply: state => { current = state; } });
  await tick();
  current = { remote: 1, local: 1 };
  harness.api.queueState(current);
  await tick();
  remote = { remote: 2 };
  remoteSeq = 2;
  harness.intervals.find(timer => timer.ms <= 10000).callback();
  await tick();
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(current)), { remote: 2, local: 1 });
  assert.equal(posts, 2, 'rebased local changes should be uploaded');
});

test('rebases a task field edit without erasing a remote running timer', async () => {
  const id = '2026-11-17:t1';
  const base = { days: { d: { tasks: [{ id, title: '数学', status: 'todo', focusStart: null, focusAcc: 0, note: '' }] } } };
  let remote = base;
  let remoteSeq = 1;
  let current = base;
  let posts = 0;
  let lastOps = null;
  const harness = createHarness(async (url, options = {}) => {
    const path = String(url);
    if (path.includes('/v1/sync/head')) return response({ headSeq: remoteSeq, revision: remoteSeq });
    if (path.includes('/v1/sync/snapshot')) return response({ state: remote, headSeq: remoteSeq, revision: remoteSeq });
    if (path.includes('/v1/sync/events')) {
      posts++;
      const body = JSON.parse(options.body);
      lastOps = body.events[0].ops;
      if (posts === 1) return response({ error: 'offline' }, 503);
      remote = {
        days: { d: { tasks: [{ id, title: '数学', status: 'doing', focusStart: 12345, focusAcc: 90, note: '平板备注' }] } }
      };
      return response({ accepted: [{ eventId: body.events[0].eventId }], headSeq: 3, revision: 3, state: remote });
    }
    if (path.includes('/v1/sync/ack')) return response({ ok: true });
    throw new Error(`unexpected request ${url}`);
  });
  harness.api.init({ get: () => current, apply: state => { current = state; } });
  await tick();

  current.days.d.tasks[0].note = '平板备注';
  harness.api.queueState(current);
  await tick();
  assert.equal(posts, 1, '平板本地编辑应先进入可重试队列');

  remote = {
    days: { d: { tasks: [{ id, title: '数学', status: 'doing', focusStart: 12345, focusAcc: 90, note: '' }] } }
  };
  remoteSeq = 2;
  harness.intervals.find(timer => timer.ms <= 10000).callback();
  await tick();
  await tick();

  const task = current.days.d.tasks[0];
  assert.equal(task.note, '平板备注', '平板的字段改动应保留');
  assert.equal(task.status, 'doing', '手机的运行状态应保留');
  assert.equal(task.focusStart, 12345, '手机计时起点应保留');
  assert.equal(task.focusAcc, 90, '手机累计时长应保留');
  assert.deepEqual(JSON.parse(JSON.stringify(lastOps)), [{
    op: 'set', path: ['days', 'd', 'tasks', '@id:' + id, 'note'], value: '平板备注'
  }], '重试事件只应提交平板实际修改的字段');
  assert.equal(posts, 2, 'rebase 后的本地字段改动应重试上传');
});

test('flushes events queued while another upload is in flight', async () => {
  const firstUpload = deferred();
  const posts = [];
  let current = { value: 0, note: '' };
  const harness = createHarness(async (url, options = {}) => {
    if (String(url).includes('/v1/sync/snapshot')) return response({ state: {}, headSeq: 0 });
    if (String(url).includes('/v1/sync/events')) {
      const event = JSON.parse(options.body).events[0];
      posts.push(event);
      if (posts.length === 1) await firstUpload.promise;
      const state = posts.length === 1 ? { value: 1, note: '', remote: true } : { value: 2, note: '', remote: true };
      return response({ accepted: [{ eventId: event.eventId }], headSeq: posts.length, state });
    }
    return response({ ok: true });
  });
  harness.api.init({ get: () => current, apply: next => { current = next; } });
  await tick();
  current.value = 1;
  harness.api.queueState(current);
  await tick();
  assert.equal(posts.length, 1);
  current.value = 2;
  harness.api.queueState(current);
  current.note = 'not saved yet';
  firstUpload.resolve();
  await tick();
  await tick();
  assert.equal(posts.length, 2, 'queued event should upload after the active request finishes');
  assert.equal(posts[1].ops[0].value, 2);
  assert.equal(current.value, 2);
  assert.equal(current.note, 'not saved yet');
  assert.equal(current.remote, true);
});

test('manual sync forces a snapshot when the local head cursor is stale', async () => {
  let current = { value: 0 };
  let snapshots = 0;
  const harness = createHarness(async url => {
    const path = String(url);
    if (path.includes('/v1/sync/head')) return response({ headSeq: 1, revision: 1 });
    if (path.includes('/v1/sync/snapshot')) {
      snapshots++;
      return response({ state: { value: 1 }, headSeq: 1, revision: 1 });
    }
    if (path.includes('/v1/sync/ack')) return response({ ok: true });
    throw new Error(`unexpected request ${url}`);
  });
  harness.values.set('chronos.cloud.head.v1', '99');
  harness.values.set('chronos.cloud.acknowledged.v1', JSON.stringify({ value: 0 }));
  harness.api.init({ get: () => current, apply: state => { current = state; } });
  await tick();
  const initialSnapshots = snapshots;
  await harness.api.syncNow();
  assert.equal(snapshots, initialSnapshots + 1, '手动同步不得被本地偏大的 head 游标短路');
  assert.deepEqual(JSON.parse(JSON.stringify(current)), { value: 1 });
});
