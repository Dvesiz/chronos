/* Chronos cloud adapter: local-first, optional Worker API. */
(function (global) {
  'use strict';

  var API_BASE = String(global.CHRONOS_API_BASE || '').replace(/\/$/, '');
  var SESSION_KEY = 'chronos.cloud.session.v1';
  var QUEUE_KEY = 'chronos.cloud.queue.v1';
  var DEVICE_KEY = 'chronos.cloud.device.v1';
  var HEAD_KEY = 'chronos.cloud.head.v1';
  var MAX_QUEUE = 100;
  var state = {
    get: function () { return null; },
    apply: function () {},
    loggedIn: false,
    syncing: false,
    booted: false,
    queuedState: null,
    queue: []
  };

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }
  function read(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || 'null') || fallback; } catch (e) { return fallback; }
  }
  function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }
  function randomId() {
    if (global.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'd-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  }
  function deviceId() {
    var id = localStorage.getItem(DEVICE_KEY);
    if (!id) { id = randomId(); try { localStorage.setItem(DEVICE_KEY, id); } catch (e) {} }
    return id;
  }
  function isObject(value) { return value && typeof value === 'object' && !Array.isArray(value); }
  function cloneOps(before, after, path, out) {
    if (JSON.stringify(before) === JSON.stringify(after)) return out;
    if (!isObject(before) || !isObject(after) || Array.isArray(before) || Array.isArray(after)) {
      out.push({ op: 'set', path: path, value: clone(after) });
      return out;
    }
    var keys = {};
    Object.keys(before).forEach(function (key) { keys[key] = true; });
    Object.keys(after).forEach(function (key) { keys[key] = true; });
    Object.keys(keys).sort().forEach(function (key) {
      var next = path.concat(key);
      if (!(key in after)) out.push({ op: 'remove', path: next });
      else if (!(key in before)) out.push({ op: 'set', path: next, value: clone(after[key]) });
      else cloneOps(before[key], after[key], next, out);
    });
    return out;
  }
  function diff(before, after) { return cloneOps(before || {}, after || {}, [], []); }

  async function request(path, options) {
    if (!API_BASE) throw new Error('cloud_disabled');
    var opts = options || {};
    var session = read(SESSION_KEY, null);
    var headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
    if (session && session.accessToken) headers.authorization = 'Bearer ' + session.accessToken;
    var response = await fetch(API_BASE + path, Object.assign({}, opts, { headers: headers }));
    if (response.status === 401 && session && session.refreshToken && path !== '/v1/auth/refresh') {
      var refreshed = await fetch(API_BASE + '/v1/auth/refresh', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: session.refreshToken })
      });
      if (refreshed.ok) {
        var next = await refreshed.json();
        write(SESSION_KEY, next);
        headers.authorization = 'Bearer ' + next.accessToken;
        response = await fetch(API_BASE + path, Object.assign({}, opts, { headers: headers }));
      }
    }
    var payload = null;
    try { payload = await response.json(); } catch (e) {}
    if (!response.ok) {
      var err = new Error(payload && payload.message || 'cloud_request_failed');
      err.code = payload && payload.error || 'cloud_request_failed';
      throw err;
    }
    return payload;
  }

  function persistQueue() { write(QUEUE_KEY, state.queue.slice(-MAX_QUEUE)); }
  function headSeq() { return Number(localStorage.getItem(HEAD_KEY) || 0); }
  function setHeadSeq(value) { try { localStorage.setItem(HEAD_KEY, String(Math.max(0, Number(value) || 0))); } catch (e) {} }
  async function flush() {
    if (!API_BASE || !state.loggedIn || state.syncing || !state.queue.length) return;
    state.syncing = true;
    try {
      var result = await request('/v1/sync/events', {
        method: 'POST', body: JSON.stringify({ events: state.queue.slice(0, 20) })
      });
      var accepted = {};
      (result.accepted || []).forEach(function (item) { accepted[item.eventId] = true; });
      state.queue = state.queue.filter(function (event) { return !accepted[event.eventId]; });
      persistQueue();
      setHeadSeq(result.headSeq || headSeq());
      state.queuedState = clone(result.state || state.queuedState);
    } catch (e) {
      /* 网络恢复后由下一次保存或 online 事件重试 */
    } finally {
      state.syncing = false;
    }
  }
  async function loginReady(auth, localState) {
    if (!API_BASE || !auth) return;
    write(SESSION_KEY, auth);
    state.loggedIn = true;
    state.queuedState = clone(localState);
    var remote = await request('/v1/sync/snapshot');
    var hasRemote = Number(remote.headSeq || 0) > 0;
    var hasLocal = !!(localState && ((localState.days && Object.keys(localState.days).length) || (localState.reviews && Object.keys(localState.reviews).length)));
    if (hasRemote && hasLocal && JSON.stringify(remote.state) !== JSON.stringify(localState)) {
      var useCloud = global.confirm('检测到云端已有 Chronos 数据。点击“确定”使用云端数据，点击“取消”保留本机数据并上传。');
      if (useCloud) {
        state.queue = [];
        persistQueue();
        state.queuedState = clone(remote.state);
        state.apply(clone(remote.state), true);
      } else {
        state.queue.push({ eventId: randomId(), deviceId: deviceId(), baseSeq: remote.headSeq || 0, ops: [{ op: 'replace', path: [], value: clone(localState) }], clientAt: Date.now() });
        setHeadSeq(remote.headSeq || 0);
        persistQueue();
      }
    } else if (!hasRemote) {
      state.queue.push({ eventId: randomId(), deviceId: deviceId(), baseSeq: remote.headSeq || 0, ops: [{ op: 'replace', path: [], value: clone(localState) }], clientAt: Date.now() });
      setHeadSeq(remote.headSeq || 0);
      persistQueue();
    } else {
      state.queuedState = clone(remote.state);
      setHeadSeq(remote.headSeq || 0);
      if (JSON.stringify(remote.state) !== JSON.stringify(localState)) state.apply(clone(remote.state), true);
    }
    await flush();
  }

  global.ChronosCloud = {
    enabled: function () { return !!API_BASE; },
    hasSession: function () { return !!read(SESSION_KEY, null); },
    sendCode: async function (email) { return request('/v1/auth/send-code', { method: 'POST', body: JSON.stringify({ email }) }).then(function () { return { mode: 'sent' }; }); },
    verify: async function (email, code) {
      var result = await request('/v1/auth/verify', { method: 'POST', body: JSON.stringify({ email: email, code: code, deviceId: deviceId() }) });
      await loginReady(result, state.get());
      return result;
    },
    logout: async function () {
      try { if (read(SESSION_KEY, null)) await request('/v1/auth/logout', { method: 'POST', body: '{}' }); } catch (e) {}
      localStorage.removeItem(SESSION_KEY);
      state.loggedIn = false;
      state.queue = [];
      persistQueue();
    },
    updateProfile: async function (profile) { return request('/v1/account/profile', { method: 'PATCH', body: JSON.stringify(profile) }); },
    feedback: async function (body) { return request('/v1/feedback', { method: 'POST', body: JSON.stringify({ body: body, appVersion: '2.6.7' }) }); },
    latest: async function () { return request('/v1/app/latest'); },
    queueState: function (nextState) {
      if (!API_BASE || !state.loggedIn || !state.booted) return;
      var next = clone(nextState);
      var before = state.queuedState || next;
      var ops = diff(before, next);
      if (!ops.length) return;
      state.queue.push({ eventId: randomId(), deviceId: deviceId(), baseSeq: headSeq(), ops: ops, clientAt: Date.now() });
      state.queue = state.queue.slice(-MAX_QUEUE);
      state.queuedState = next;
      persistQueue();
      flush();
    },
    init: function (hooks) {
      state.get = hooks.get;
      state.apply = hooks.apply;
      state.queue = read(QUEUE_KEY, []);
      state.queuedState = clone(state.get());
      state.loggedIn = !!read(SESSION_KEY, null);
      state.booted = true;
      if (state.loggedIn) {
        request('/v1/sync/snapshot').then(function (remote) {
          if (remote && remote.state) {
            setHeadSeq(remote.headSeq || 0);
            if (state.queue.length === 0 && JSON.stringify(remote.state) !== JSON.stringify(state.get())) {
              state.queuedState = clone(remote.state);
              state.apply(clone(remote.state), true);
            }
          }
          flush();
        }).catch(function () { flush(); });
      }
    },
    isSyncing: function () { return state.syncing; }
  };
  global.addEventListener('online', flush);
})(window);
