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

function createHarness(fetchImpl) {
  const values = new Map();
  const intervals = [];
  const listeners = {};
  const localStorage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
  values.set('chronos.cloud.session.v1', JSON.stringify({ accessToken: 'access', refreshToken: 'refresh' }));
  const document = { hidden: false, addEventListener: (name, callback) => { listeners[`document:${name}`] = callback; } };
  const window = {
    CHRONOS_API_BASE: 'https://api.example',
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

test('flushes events queued while another upload is in flight', async () => {
  const firstUpload = deferred();
  let postCount = 0;
  const harness = createHarness(async (url, options = {}) => {
    if (String(url).includes('/v1/sync/snapshot')) return response({ state: {}, headSeq: 0 });
    if (String(url).includes('/v1/sync/events')) {
      postCount++;
      const event = JSON.parse(options.body).events[0];
      if (postCount === 1) await firstUpload.promise;
      return response({ accepted: [{ eventId: event.eventId }], headSeq: postCount, state: {} });
    }
    throw new Error(`unexpected request ${url}`);
  });
  harness.api.init({ get: () => ({}), apply: () => {} });
  await tick();
  harness.api.queueState({ value: 1 });
  await tick();
  assert.equal(postCount, 1);
  harness.api.queueState({ value: 2 });
  firstUpload.resolve();
  await tick();
  await tick();
  assert.equal(postCount, 2, 'queued event should upload after the active request finishes');
});
