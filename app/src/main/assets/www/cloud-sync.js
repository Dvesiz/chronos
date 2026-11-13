/* Chronos cloud adapter: local-first, optional Worker API. */
(function (global) {
  'use strict';

  var API_BASE = String(global.CHRONOS_API_BASE || '').replace(/\/$/, '');
  // 版本号统一来自 cloud-config.js（与 AndroidManifest 的 versionName 同源）
  var APP_VERSION = String(global.CHRONOS_APP_VERSION || 'dev');
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
    queue: [],
    pulling: false,
    pollTimer: null
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
  /**
   * 结构相等判断（替代每层递归都 JSON.stringify 的旧写法）。
   *
   * 旧实现 cloneOps 在每一层递归都执行
   *   if (JSON.stringify(before) === JSON.stringify(after)) return out;
   * 等于对每个子树做一次完整序列化：days 涨到 120 天后，一次 save 会
   * 序列化几十次整个子树。这里改为就地短路比较，代价降到 O(变化量)。
   */
  function sameValue(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a === null || b === null) return false;
    if (typeof a !== 'object') return false;   // 原始类型已由 a === b 覆盖
    var aArr = Array.isArray(a), bArr = Array.isArray(b);
    if (aArr !== bArr) return false;
    if (aArr) {
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false;
      return true;
    }
    var ak = Object.keys(a), bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (var j = 0; j < ak.length; j++) {
      var k = ak[j];
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!sameValue(a[k], b[k])) return false;
    }
    return true;
  }

  function cloneOps(before, after, path, out) {
    if (sameValue(before, after)) return out;
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

  async function fetchWithTimeout(url, options) {
    var controller = global.AbortController ? new global.AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 15000) : null;
    var requestOpts = Object.assign({}, options || {});
    if (controller) requestOpts.signal = controller.signal;
    try {
      return await fetch(url, requestOpts);
    } catch (e) {
      var networkError = new Error(e && e.name === 'AbortError' ? 'cloud_timeout' : 'cloud_network');
      networkError.code = networkError.message;
      throw networkError;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function request(path, options) {
    if (!API_BASE) throw new Error('cloud_disabled');
    var opts = options || {};
    var session = read(SESSION_KEY, null);
    var headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
    if (session && session.accessToken) headers.authorization = 'Bearer ' + session.accessToken;
    var requestOpts = Object.assign({}, opts, { headers: headers });
    var response = await fetchWithTimeout(API_BASE + path, requestOpts);
    if (response.status === 401 && session && session.refreshToken && path !== '/v1/auth/refresh') {
      var refreshed = await fetchWithTimeout(API_BASE + '/v1/auth/refresh', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: session.refreshToken })
      });
      if (refreshed.ok) {
        var next = await refreshed.json();
        write(SESSION_KEY, next);
        headers.authorization = 'Bearer ' + next.accessToken;
        response = await fetchWithTimeout(API_BASE + path, Object.assign({}, opts, { headers: headers }));
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

  /**
   * 队列过长时塌缩成一条合并事件，而不是丢弃最旧的。
   *
   * 旧实现用 slice(-MAX_QUEUE) 硬截断：连续离线改 100 次以上，最早的改动
   * 会被静默扔掉（而且没有任何提示）。离线场景下这是真实的数据丢失。
   *
   * 现在改为：把整条队列重放到「已确认云端状态」上，用最终结果反向 diff 出
   * 一条合并事件。中间过程会丢，但**最终状态一定能传到云端**。
   */
  function compactQueue() {
    if (state.queue.length <= MAX_QUEUE) return;
    var base = state.queuedState ? clone(state.queuedState) : {};
    // queuedState 已经是含全部本地改动后的状态，直接与云端基线比对即可
    var merged = diff(base, state.get ? state.get() : base);
    var keep = state.queue.slice(-1)[0] || null;
    state.queue = merged.length ? [{
      eventId: randomId(),
      deviceId: deviceId(),
      baseSeq: keep ? keep.baseSeq : headSeq(),
      ops: merged,
      clientAt: Date.now()
    }] : [];
  }
  function headSeq() { return Number(localStorage.getItem(HEAD_KEY) || 0); }
  function setHeadSeq(value) { try { localStorage.setItem(HEAD_KEY, String(Math.max(0, Number(value) || 0))); } catch (e) {} }

  /**
   * 云端要覆盖本地之前，先把本地快照留一份。
   * 上次事故里本地数据是被直接替换掉的，用户完全没有回退余地。
   * 只保留最近一份，避免占满 localStorage。
   */
  var BACKUP_KEY = 'chronos.state.before-cloud-sync';
  function backupLocal(reason) {
    try {
      var snapshot = state.get();
      if (!snapshot) return;
      // 空数据的本机没有备份价值，别把云端数据挤掉
      var hasData = (snapshot.days && Object.keys(snapshot.days).length) ||
                    (snapshot.reviews && Object.keys(snapshot.reviews).length);
      if (!hasData) return;
      localStorage.setItem(BACKUP_KEY, JSON.stringify({
        at: Date.now(),
        reason: reason || 'cloud_overwrite',
        state: snapshot
      }));
    } catch (e) {}
  }
  function applyRemote(next, reason) {
    if (JSON.stringify(next) === JSON.stringify(state.get())) return;
    backupLocal(reason);
    state.queuedState = clone(next);
    state.apply(clone(next), true);
  }
  async function flush() {
    if (!API_BASE || !state.loggedIn || state.syncing || !state.queue.length) return;
    state.syncing = true;
    var uploaded = false;
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
      uploaded = true;
    } catch (e) {
      // 服务端拒绝整份 replace：说明队列里是旧版逻辑留下的破坏性事件。
      // 直接丢弃这些事件并拉取云端，绝不再重试（否则会一直顶着云端状态）。
      if (e && e.code === 'replace_forbidden') {
        state.queue = state.queue.filter(function (event) {
          return !(event.ops || []).some(function (op) {
            return op.op === 'replace' && (!op.path || op.path.length === 0);
          });
        });
        persistQueue();
        state.syncing = false;
        pullLatest();
        return;
      }
      /* 其它错误：网络恢复后由下一次保存或 online 事件重试 */
    } finally {
      state.syncing = false;
      if (uploaded && state.loggedIn && state.queue.length) flush();
    }
  }
  async function pullLatest() {
    if (!API_BASE || !state.loggedIn || !state.booted || state.pulling || state.syncing) return;
    state.pulling = true;
    try {
      var head = await request('/v1/sync/head');
      if (state.syncing) return;
      var remoteSeq = Number(head && head.headSeq || 0);
      if (remoteSeq <= headSeq()) { flush(); return; }
      var remote = await request('/v1/sync/snapshot');
      if (!remote || !remote.state) return;
      remoteSeq = Number(remote.headSeq || remoteSeq);
      setHeadSeq(remoteSeq);
      if (state.queue.length) {
        var merged = clone(remote.state);
        state.queue.forEach(function (event) { merged = applyLocalOps(merged, event.ops); });
        var rebasedOps = diff(remote.state, merged);
        state.queue = rebasedOps.length ? [{ eventId: randomId(), deviceId: deviceId(), baseSeq: remoteSeq, ops: rebasedOps, clientAt: Date.now() }] : [];
        state.queuedState = clone(merged);
        persistQueue();
        applyRemote(merged, 'rebase');
        flush();
      } else {
        applyRemote(remote.state, 'poll');
      }
    } catch (e) {
      /* Keep local state and retry on the next poll, resume, or online event. */
    } finally {
      state.pulling = false;
    }
  }
  function applyLocalOps(value, ops) {
    var root = clone(value) || {};
    (ops || []).forEach(function (op) {
      if (!op.path || !op.path.length) { if (op.op === 'replace') root = clone(op.value) || {}; return; }
      var parent = root;
      for (var i = 0; i < op.path.length - 1; i++) {
        var key = op.path[i];
        if (!parent[key] || typeof parent[key] !== 'object') parent[key] = {};
        parent = parent[key];
      }
      var last = op.path[op.path.length - 1];
      if (op.op === 'remove') delete parent[last];
      else if (op.op === 'set') parent[last] = clone(op.value);
    });
    return root;
  }
  function startPolling() {
    if (!state.pollTimer) state.pollTimer = global.setInterval(pullLatest, 5000);
  }

  /**
   * 登录后的首次对账。
   *
   * 历史事故：这里曾提供「保留本机数据并上传」，用一条全量 replace 覆盖云端。
   * 在浏览器登录时，本机往往是很久以前的旧数据，一次点击就把安卓几小时的
   * 新记录整份抹掉，随后所有设备都同步成旧数据。
   *
   * 新规则（不对称，故意偏向云端）：
   *  1. 云端有数据 → 一律以云端为准，本地覆盖成云端，绝不上传本地；
   *  2. 云端为空   → 本地有数据才上传（这是唯一允许全量上传的时机），
   *                  否则什么都不做。
   */
  async function loginReady(auth, localState) {
    if (!API_BASE || !auth) return;
    write(SESSION_KEY, auth);
    state.loggedIn = true;
    startPolling();
    state.queuedState = clone(localState);

    var remote = await request('/v1/sync/snapshot');
    var hasRemote = Number(remote.headSeq || 0) > 0;

    if (hasRemote) {
      // 丢弃任何在登录前残留的队列，避免旧操作被重放
      state.queue = [];
      persistQueue();
      setHeadSeq(remote.headSeq || 0);
      applyRemote(remote.state, 'login');
      return;
    }

    // 云端为空：只在这时把本地数据抬上去
    var hasLocal = !!(localState && (
      (localState.days && Object.keys(localState.days).length) ||
      (localState.reviews && Object.keys(localState.reviews).length) ||
      (localState.template && localState.template.length)
    ));
    state.queue = [];
    if (hasLocal) {
      state.queue.push({ eventId: randomId(), deviceId: deviceId(), baseSeq: 0, ops: [{ op: 'replace', path: [], value: clone(localState) }], clientAt: Date.now() });
    }
    setHeadSeq(0);
    persistQueue();
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
      if (state.pollTimer) {
        global.clearInterval(state.pollTimer);
        state.pollTimer = null;
      }
      state.queue = [];
      persistQueue();
    },
    updateProfile: async function (profile) { return request('/v1/account/profile', { method: 'PATCH', body: JSON.stringify(profile) }); },
    feedback: async function (body) { return request('/v1/feedback', { method: 'POST', body: JSON.stringify({ body: body, appVersion: APP_VERSION }) }); },
    latest: async function () { return request('/v1/app/latest'); },
    queueState: function (nextState) {
      if (!API_BASE || !state.loggedIn || !state.booted) return;
      var next = clone(nextState);
      var before = state.queuedState || next;
      var ops = diff(before, next);
      if (!ops.length) return;
      state.queue.push({ eventId: randomId(), deviceId: deviceId(), baseSeq: headSeq(), ops: ops, clientAt: Date.now() });
      compactQueue();
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
        // 打开页面时同样以云端为准：先丢掉旧队列，再拉快照覆盖本地。
        // 只有本地干净（无待传队列）时才直接覆盖，避免吞掉真正的未上传改动。
        request('/v1/sync/snapshot').then(function (remote) {
          if (remote && remote.state) {
            setHeadSeq(remote.headSeq || 0);
            if (Number(remote.headSeq || 0) > 0) {
              // 云端已有数据：本地队列若源自旧版本的全量 replace，必须丢弃
              state.queue = state.queue.filter(function (event) {
                return !(event.ops || []).some(function (op) {
                  return op.op === 'replace' && (!op.path || op.path.length === 0);
                });
              });
              persistQueue();
              applyRemote(remote.state, 'boot');
            }
          }
          flush();
        }).catch(function () { flush(); });
        startPolling();
      }
    },
    isSyncing: function () { return state.syncing || state.pulling; },
    syncNow: pullLatest
  };
  global.addEventListener('online', function () { pullLatest(); flush(); });
  global.addEventListener('focus', pullLatest);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) pullLatest(); });
})(window);
