/* Chronos cloud adapter: local-first, optional Worker API. */
(function (global) {
  'use strict';

  var API_BASE = String(global.CHRONOS_API_BASE || '').replace(/\/$/, '');
  // 版本号统一来自 cloud-config.js（与 AndroidManifest 的 versionName 同源）
  var APP_VERSION = String(global.CHRONOS_APP_VERSION || 'dev');
  var SESSION_KEY = 'chronos.cloud.session.v1';
  var QUEUE_KEY = 'chronos.cloud.queue.v1';
  var ACK_KEY = 'chronos.cloud.acknowledged.v1';
  var DEVICE_KEY = 'chronos.cloud.device.v1';
  var HEAD_KEY = 'chronos.cloud.head.v1';
  var REVISION_KEY = 'chronos.cloud.revision.v1';
  var PROTOCOL_VERSION = 2;
  var SCHEMA_VERSION = 3;
  var MAX_QUEUE = 100;
  var RETRY_BACKOFF = [2000, 4000, 8000, 16000, 32000];
  var OUTBOX_DB = 'chronos-sync-v1';
  var outboxDbPromise = null;
  var outboxWriteChain = Promise.resolve();
  function normalizeScope(scope) {
    return scope === undefined || scope === null || scope === '' ? null : String(scope);
  }
  function scopedKey(base, scope) {
    var normalized = normalizeScope(scope);
    return normalized === null ? base : base + '.v2.' + encodeURIComponent(normalized);
  }
  function eventScope(event) { return normalizeScope(event && event.accountScope); }
  function reviveRetryableEvents(queue) {
    return (queue || []).map(function (event) {
      if (!event || event.status !== 'rejected' || event.error !== 'stale_revision') return event;
      var revived = Object.assign({}, event);
      revived.status = 'pending';
      delete revived.error;
      return revived;
    });
  }
  function mergeQueues(primary, secondary) {
    var byId = {};
    (primary || []).concat(secondary || []).forEach(function (event) {
      if (!event || !event.eventId) return;
      var previous = byId[event.eventId];
      if (!previous || Number(event.queuedAt || 0) >= Number(previous.queuedAt || 0)) byId[event.eventId] = event;
    });
    return Object.keys(byId).map(function (key) { return byId[key]; });
  }
  function readQueueForScope(scope) {
    var normalized = normalizeScope(scope);
    var queue = reviveRetryableEvents(read(scopedKey(QUEUE_KEY, normalized), []));
    if (normalized !== null) {
      var legacy = read(QUEUE_KEY, []);
      var legacyForScope = reviveRetryableEvents(legacy.filter(function (event) {
        return eventScope(event) === normalized;
      }));
      queue = mergeQueues(queue, legacyForScope);
      if (legacyForScope.length) {
        write(QUEUE_KEY, legacy.filter(function (event) { return eventScope(event) !== normalized; }));
      }
    }
    var scoped = (queue || []).filter(function (event) { return eventScope(event) === normalized; });
    if (normalized !== null && JSON.stringify(scoped) !== JSON.stringify(queue)) write(scopedKey(QUEUE_KEY, normalized), scoped);
    return scoped;
  }
  function writeQueueLocal(scope, queue) {
    var normalized = normalizeScope(scope);
    var key = scopedKey(QUEUE_KEY, normalized);
    if (normalized === null) {
      var existing = read(key, []);
      var foreign = existing.filter(function (event) { return eventScope(event) !== null; });
      write(key, mergeQueues(foreign, queue || []));
      return;
    }
    write(key, (queue || []).filter(function (event) { return eventScope(event) === normalized; }));
  }
  function openOutboxDb() {
    if (!global.indexedDB) return Promise.resolve(null);
    if (outboxDbPromise) return outboxDbPromise;
    outboxDbPromise = new Promise(function (resolve) {
      try {
        var req = global.indexedDB.open(OUTBOX_DB, 1);
        req.onupgradeneeded = function () { req.result.createObjectStore('outbox', { keyPath: 'eventId' }); };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { resolve(null); };
        req.onblocked = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
    return outboxDbPromise;
  }
  function persistQueueIndexedDb(queue, scope) {
    var normalized = normalizeScope(scope);
    var snapshot = (queue || []).filter(function (event) { return eventScope(event) === normalized; }).map(clone);
    outboxWriteChain = outboxWriteChain.catch(function () {}).then(function () {
      return openOutboxDb().then(function (db) {
        if (!db) return;
        return new Promise(function (resolve) {
          try {
            var tx = db.transaction('outbox', 'readwrite');
            var store = tx.objectStore('outbox');
            var request = store.getAll();
            request.onsuccess = function () {
              var ids = {};
              snapshot.forEach(function (event) { if (event && event.eventId) ids[event.eventId] = true; });
              (request.result || []).forEach(function (event) {
                if (eventScope(event) === normalized && !ids[event.eventId]) store.delete(event.eventId);
              });
              snapshot.forEach(function (event) { if (event && event.eventId) store.put(event); });
            };
            tx.oncomplete = function () { resolve(); };
            tx.onerror = function () { resolve(); };
            tx.onabort = function () { resolve(); };
          } catch (e) { resolve(); }
        });
      });
    });
    return outboxWriteChain;
  }
  function loadQueueFromIndexedDb(scope) {
    var normalized = normalizeScope(scope);
    return openOutboxDb().then(function (db) {
      if (!db) return;
      return new Promise(function (resolve) {
        try {
          var req = db.transaction('outbox', 'readonly').objectStore('outbox').getAll();
          req.onsuccess = function () {
            var rows = reviveRetryableEvents((req.result || []).filter(function (event) { return eventScope(event) === normalized; }));
            if (rows.length) {
              state.queue = mergeQueues(state.queue, rows);
              writeQueueLocal(normalized, state.queue);
            }
            resolve();
          };
          req.onerror = function () { resolve(); };
        } catch (e) { resolve(); }
      });
    });
  }
  var tabChannel = null;
  try {
    if (global.BroadcastChannel) {
      tabChannel = new global.BroadcastChannel('chronos-sync-v1');
    }
  } catch (e) { tabChannel = null; }

  var state = {
    get: function () { return null; },
    apply: function () {},
    loggedIn: false,
    syncing: false,
    booted: false,
    queuedState: null,
    queue: [],
    queueScope: null,
    queueReady: Promise.resolve(),
    pulling: false,
    pollTimer: null,
    queueHydrated: false,
    syncStatus: 'idle',
    retryAttempt: 0,
    retryTimer: null,
    lastError: null,
    lastSyncAt: 0,
    getLocalRevision: function () { return 0; },
    initialSyncInFlight: false
  };

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }
  function collectDeletedEntities(before, after) {
    var out = [];
    var beforeDays = before && before.days || {};
    var afterDays = after && after.days || {};
    Object.keys(beforeDays).forEach(function (date) {
      var oldTasks = beforeDays[date] && beforeDays[date].tasks || [];
      var newIds = new Set((afterDays[date] && afterDays[date].tasks || []).map(function (t) { return t.id; }));
      oldTasks.forEach(function (task) {
        if (task && task.id && !newIds.has(task.id)) out.push({ entityType: 'task', entityId: task.id });
      });
    });
    return out;
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
  function accountScope() {
    var session = read(SESSION_KEY, null);
    return session && session.user && (session.user.id || session.user.email)
      ? String(session.user.id || session.user.email) : null;
  }
  function currentQueueScope() {
    return normalizeScope(state.queueScope);
  }
  function adoptQueueScope() {
    var scope = currentQueueScope();
    state.queue = state.queue.filter(function (event) { return eventScope(event) === scope; });
  }
  function eligibleQueue() {
    var scope = currentQueueScope();
    return state.queue.filter(function (event) {
      return event && eventScope(event) === scope && event.status !== 'conflict' && event.status !== 'rejected';
    });
  }
  function isObject(value) { return value && typeof value === 'object' && !Array.isArray(value); }
  function arrayItemId(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    if (typeof item.id === 'string' && item.id) return item.id;
    if (typeof item.sessionId === 'string' && item.sessionId) return item.sessionId;
    if (typeof item.taskId === 'string' && item.taskId) return item.taskId;
    return null;
  }
  function keyedArray(value, path) {
    if (!Array.isArray(value) || !path.length || ['tasks', 'partialFocus'].indexOf(path[path.length - 1]) < 0) return null;
    var ids = value.map(arrayItemId);
    if (ids.some(function (id) { return id === null; }) || new Set(ids).size !== ids.length) return null;
    return ids;
  }
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
    if (Array.isArray(before) && Array.isArray(after)) {
      var beforeIds = keyedArray(before, path);
      var afterIds = keyedArray(after, path);
      if (beforeIds && afterIds) {
        var beforeById = new Map(before.map(function (item, index) { return [beforeIds[index], item]; }));
        var afterSet = new Set(afterIds);
        after.forEach(function (item, index) {
          var id = afterIds[index];
          var itemPath = path.concat('@id:' + id);
          if (!beforeById.has(id)) out.push({ op: 'set', path: itemPath, value: clone(item) });
          else cloneOps(beforeById.get(id), item, itemPath, out);
        });
        beforeIds.forEach(function (id) {
          if (!afterSet.has(id)) out.push({ op: 'remove', path: path.concat('@id:' + id) });
        });
        return out;
      }
    }
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

  var refreshInFlight = null;
  function refreshSession(expired) {
    if (refreshInFlight && refreshInFlight.token === expired.refreshToken) return refreshInFlight.promise;
    var flight = { token: expired.refreshToken };
    var refresh = async function () {
      var current = read(SESSION_KEY, null);
      if (!current || current.user?.id !== expired.user?.id) return null;
      // Another tab or request may already have rotated these credentials.
      if (current.accessToken !== expired.accessToken) return current;
      var response = await fetchWithTimeout(API_BASE + '/v1/auth/refresh', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken })
      });
      var next = response.ok ? await response.json() : null;
      var latest = read(SESSION_KEY, null);
      if (!latest || latest.user?.id !== expired.user?.id) return null;
      if (latest.accessToken !== current.accessToken) return latest;
      if (next && next.accessToken && next.refreshToken) {
        write(SESSION_KEY, next);
        return next;
      }
      if (response.status >= 500 || response.status === 429) {
        var error = new Error('cloud_refresh_unavailable');
        error.code = error.message;
        throw error;
      }
      return null;
    };
    var locks = global.navigator && global.navigator.locks;
    flight.promise = Promise.resolve().then(function () {
      return locks && typeof locks.request === 'function' ? locks.request('chronos-auth-refresh', refresh) : refresh();
    }).finally(function () {
      if (refreshInFlight === flight) refreshInFlight = null;
    });
    refreshInFlight = flight;
    return flight.promise;
  }

  async function request(path, options) {
    if (!API_BASE) throw new Error('cloud_disabled');
    var opts = options || {};
    var session = read(SESSION_KEY, null);
    var headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
    if (session && session.accessToken) headers.authorization = 'Bearer ' + session.accessToken;
    var requestOpts = Object.assign({}, opts, { headers: headers });
    var response = await fetchWithTimeout(API_BASE + path, requestOpts);
    if (response.status === 401 && session && session.refreshToken && (path.indexOf('/v1/auth/') !== 0 || path === '/v1/auth/logout')) {
      var next = await refreshSession(session);
      if (next) {
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
    if (payload && payload.state && (path === '/v1/sync/snapshot' || path === '/v1/sync/events')) {
      // Older clients may have included a profile in the shared document.
      var businessState = Object.assign({}, payload.state);
      delete businessState.user;
      payload = Object.assign({}, payload, { state: businessState });
    }
    return payload;
  }

  function withWriteLock(work) {
    var locks = global.navigator && global.navigator.locks;
    if (!locks || typeof locks.request !== 'function') return work();
    return locks.request('chronos-sync-write', { mode: 'exclusive' }, work);
  }
  function withQueueWriteLock(work) {
    return Promise.resolve(withWriteLock(function () {
      // 读取同一作用域的最新持久化队列，再合并当前标签页的内存队列，
      // 避免两个标签页各自基于旧快照写回时互相覆盖。
      state.queue = mergeQueues(readQueueForScope(currentQueueScope()), state.queue);
      return work();
    }));
  }
  function persistQueueForScope(scope, queue) {
    writeQueueLocal(scope, queue);
    persistQueueIndexedDb(queue, scope);
  }
  function persistQueue() { persistQueueForScope(currentQueueScope(), state.queue); }
  function notifyTabs() { try { if (tabChannel) tabChannel.postMessage({ type: 'state-changed', at: Date.now() }); } catch (e) {} }
  if (tabChannel) tabChannel.onmessage = function (event) {
    if (event && event.data && event.data.type === 'state-changed') pullLatest(true);
  };
  function acknowledgedState() { return read(scopedKey(ACK_KEY, currentQueueScope()), null); }
  function setAcknowledged(next) { if (next) write(scopedKey(ACK_KEY, currentQueueScope()), clone(next)); }

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
    var base = acknowledgedState() || state.queuedState || {};
    // 只从最后一次服务端确认状态计算，不能以 queuedState 作为云端基线
    var merged = diff(base, state.get ? state.get() : base);
    var keep = state.queue.slice(-1)[0] || null;
    var deleteEntities = mergeDeleteEntities(state.queue);
    state.queue = merged.length ? [{
      eventId: randomId(),
      deviceId: deviceId(),
      accountScope: currentQueueScope(),
      baseSeq: keep ? keep.baseSeq : headSeq(),
      baseRevision: revision(),
      ops: merged,
      deleteEntities: deleteEntities,
      queuedAt: Date.now(),
      clientAt: Date.now()
    }] : [];
  }
  function headSeq() { return Number(localStorage.getItem(scopedKey(HEAD_KEY, currentQueueScope())) || 0); }
  function setHeadSeq(value) { try { localStorage.setItem(scopedKey(HEAD_KEY, currentQueueScope()), String(Math.max(0, Number(value) || 0))); } catch (e) {} }
  function revision() { return Number(localStorage.getItem(scopedKey(REVISION_KEY, currentQueueScope())) || 0); }
  function setRevision(value) { try { localStorage.setItem(scopedKey(REVISION_KEY, currentQueueScope()), String(Math.max(0, Number(value) || 0))); } catch (e) {} }
  function mergeDeleteEntities(events) {
    var seen = {};
    var out = [];
    (events || []).forEach(function (event) {
      (event && event.deleteEntities || []).forEach(function (entity) {
        if (!entity || !entity.entityType || !entity.entityId) return;
        var key = String(entity.entityType) + ':' + String(entity.entityId);
        if (seen[key]) return;
        seen[key] = true;
        out.push({ entityType: String(entity.entityType), entityId: String(entity.entityId) });
      });
    });
    return out;
  }

  /**
   * 云端要覆盖本地之前，先把本地快照留一份。
   * 上次事故里本地数据是被直接替换掉的，用户完全没有回退余地。
   * 只保留最近一份，避免占满 localStorage。
   */
  var BACKUP_KEY = 'chronos.state.backups.v1';
  var MAX_BACKUPS = 5;
  function backupLocal(reason) {
    try {
      var snapshot = state.get();
      if (!snapshot) return;
      // 空数据的本机没有备份价值，别把云端数据挤掉
      var hasData = (snapshot.days && Object.keys(snapshot.days).length) ||
                    (snapshot.reviews && Object.keys(snapshot.reviews).length);
      if (!hasData) return;
      var backups = read(BACKUP_KEY, []);
      if (!Array.isArray(backups)) backups = [];
      backups.unshift({ at: Date.now(), reason: reason || 'cloud_overwrite', state: snapshot });
      write(BACKUP_KEY, backups.slice(0, MAX_BACKUPS));
    } catch (e) {}
  }
  function applyRemote(next, reason) {
    if (JSON.stringify(next) === JSON.stringify(state.get())) return;
    backupLocal(reason);
    state.queuedState = clone(next);
    state.apply(clone(next), true);
  }
  async function flush() {
    var pending = eligibleQueue();
    if (!API_BASE || !state.loggedIn || state.syncing || state.initialSyncInFlight || !pending.length || state.queueHydrated === false) return;
    state.syncing = true;
    state.syncStatus = 'uploading';
    var uploaded = false;
    var retryAfterPull = false;
    try {
      var result = await request('/v1/sync/events', {
        method: 'POST', body: JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        schemaVersion: SCHEMA_VERSION,
        accountScope: currentQueueScope(),
        baseRevision: revision(),
        events: pending.slice(0, 20).map(function (event) {
          return Object.assign({}, event, { accountScope: currentQueueScope(), baseRevision: revision(), deleteEntities: event.deleteEntities || [] });
        })
      })
      });
      var accepted = {};
      var resultHasStaleRevision = false;
      if (Array.isArray(result.results)) {
        result.results.forEach(function (item) {
          if (!item) return;
          if (item.status === 'accepted') accepted[item.eventId] = true;
          // 批量接口可能已经接受了前面的事件，然后以 HTTP 200 在逐事件结果里
          // 返回 stale_revision。这个事件必须保留为可重试状态，不能永久标记 rejected。
          if (item.status === 'stale_revision' || item.error === 'stale_revision') {
            resultHasStaleRevision = true;
            state.queue.forEach(function (event) {
              if (event.eventId === item.eventId) {
                event.status = 'pending';
                delete event.error;
              }
            });
            return;
          }
          if (item.status === 'conflict' || item.status === 'rejected') {
            state.queue.forEach(function (event) {
              if (event.eventId === item.eventId) { event.status = item.status; event.error = item.error || null; }
            });
          }
        });
      } else {
        (result.accepted || []).forEach(function (item) { accepted[item.eventId] = true; });
      }
      await withQueueWriteLock(function () {
        state.queue = state.queue.filter(function (event) { return !accepted[event.eventId]; });
        persistQueue();
        setHeadSeq(result.headSeq || headSeq());
        setRevision(result.revision == null ? revision() : result.revision);
        if (result.state && !resultHasStaleRevision && Object.keys(accepted).length &&
            !state.queue.some(function (event) { return event.status === 'conflict' || event.status === 'rejected'; })) {
          var unsaved = diff(state.queuedState, state.get());
          var merged = result.state;
          eligibleQueue().forEach(function (event) { merged = applyLocalOps(merged, event.ops); });
          state.queuedState = clone(merged);
          // Keep edits made while the request was in flight, including debounced saves.
          var visible = applyLocalOps(merged, unsaved);
          if (JSON.stringify(visible) !== JSON.stringify(state.get())) {
            backupLocal('upload');
            state.apply(visible, true);
          }
        }
        setAcknowledged(result.state || state.queuedState);
      });
      if (result.headSeq != null && accepted && Object.keys(accepted).length) {
        request('/v1/sync/ack', { method: 'POST', body: JSON.stringify({ deviceId: deviceId(), ackServerSeq: result.headSeq, appVersion: APP_VERSION, protocolVersion: 2 }) }).catch(function () {});
      }
      uploaded = true;
      state.retryAttempt = 0;
      state.lastError = null;
      state.lastSyncAt = Date.now();
      if (resultHasStaleRevision) {
        state.syncStatus = 'recovery_required';
        state.lastError = 'stale_revision';
        retryAfterPull = true;
      } else state.syncStatus = state.queue.some(function (event) { return event.status === 'conflict' || event.status === 'rejected'; })
        ? 'conflict' : (state.queue.length ? 'pending' : 'idle');
      notifyTabs();
    } catch (e) {
      // 服务端拒绝整份 replace：说明队列里是旧版逻辑留下的破坏性事件。
      // 直接丢弃这些事件并拉取云端，绝不再重试（否则会一直顶着云端状态）。
      if (e && e.code === 'stale_revision') {
        state.syncStatus = 'recovery_required';
        state.lastError = e.code;
        retryAfterPull = true;
        return;
      }
      if (e && e.code === 'replace_forbidden') {
        state.queue.forEach(function (event) {
          if (eligibleQueue().indexOf(event) >= 0 && (event.ops || []).some(function (op) {
            return op.op === 'replace' && (!op.path || op.path.length === 0);
          })) event.status = 'conflict';
        });
        persistQueue();
        state.syncStatus = 'conflict';
        state.lastError = e.code;
        pullLatest(true);
        return;
      }
      state.syncStatus = e && (e.code === 'cloud_timeout' || e.code === 'cloud_network') ? 'retrying' : 'failed';
      state.lastError = e && e.code ? String(e.code) : 'cloud_request_failed';
      state.retryAttempt = Math.min(state.retryAttempt + 1, RETRY_BACKOFF.length - 1);
      if (state.retryTimer) global.clearTimeout(state.retryTimer);
      state.retryTimer = global.setTimeout(function () { state.retryTimer = null; flush(); }, RETRY_BACKOFF[state.retryAttempt]);
      if (state.retryTimer && typeof state.retryTimer.unref === 'function') state.retryTimer.unref();
    } finally {
      state.syncing = false;
      if (retryAfterPull && state.loggedIn) pullLatest(true);
      else if (uploaded && state.loggedIn && state.queue.length) flush();
    }
  }
  async function pullLatest(forceSnapshot) {
    if (!API_BASE || !state.loggedIn || !state.booted || state.initialSyncInFlight || state.pulling || state.syncing) return;
    state.pulling = true;
    state.syncStatus = 'pulling';
    var localRevisionAtStart = Number(state.getLocalRevision() || 0);
    try {
      var head = await request('/v1/sync/head');
      if (state.syncing) return;
      var remoteSeq = Number(head && head.headSeq || 0);
      // 没有 acknowledged snapshot 时，即使 headSeq 相等也必须拉一次快照，
      // 否则离线队列压缩会错误退回 queuedState 作为云端基线。
      if (!forceSnapshot && remoteSeq <= headSeq() && acknowledgedState()) { await flush(); return; }
      var remote = await request('/v1/sync/snapshot');
      if (!remote || !remote.state) return;
      remoteSeq = Number(remote.headSeq || remoteSeq);
      setHeadSeq(remoteSeq);
      setRevision(remote.revision == null ? revision() : remote.revision);
      setAcknowledged(remote.state);
      if (remoteSeq >= 0) request('/v1/sync/ack', { method: 'POST', body: JSON.stringify({ deviceId: deviceId(), ackServerSeq: remoteSeq, appVersion: APP_VERSION, protocolVersion: PROTOCOL_VERSION }) }).catch(function () {});
      if (Number(state.getLocalRevision() || 0) !== localRevisionAtStart && !state.queue.length) {
        var raced = diff(remote.state, state.get());
        if (raced.length) state.queue.push({ eventId: randomId(), deviceId: deviceId(), accountScope: currentQueueScope(), baseSeq: remoteSeq, baseRevision: revision(), ops: raced, deleteEntities: collectDeletedEntities(remote.state, state.get()), queuedAt: Date.now(), clientAt: Date.now() });
        state.queuedState = clone(state.get());
        persistQueue();
        state.syncStatus = 'pending';
        await flush();
      } else if (eligibleQueue().length || state.queue.some(function (event) { return event.status === 'conflict' || event.status === 'rejected'; })) {
        await rebaseQueue(remote.state, remoteSeq);
        await flush();
      } else {
        applyRemote(remote.state, 'poll');
      }
      if (!state.lastError) {
        state.lastSyncAt = Date.now();
        state.syncStatus = state.queue.length ? 'pending' : 'idle';
      }
    } catch (e) {
      state.syncStatus = e && (e.code === 'cloud_timeout' || e.code === 'cloud_network') ? 'retrying' : 'failed';
      state.lastError = e && e.code ? String(e.code) : 'cloud_request_failed';
    } finally {
      state.pulling = false;
    }
  }
  function applyLocalOps(value, ops) {
    var root = clone(value) || {};
    function arrayIndex(array, segment) {
      if (/^\d+$/.test(segment)) return Number(segment);
      if (segment.indexOf('@id:') !== 0) return -1;
      var id = segment.slice(4);
      return array.findIndex(function (item) { return arrayItemId(item) === id; });
    }
    (ops || []).forEach(function (op) {
      if (!op.path || !op.path.length) { if (op.op === 'replace') root = clone(op.value) || {}; return; }
      var parent = root;
      for (var i = 0; i < op.path.length - 1; i++) {
        var key = op.path[i];
        if (Array.isArray(parent)) {
          var index = arrayIndex(parent, key);
          if (index < 0 || !parent[index] || typeof parent[index] !== 'object') return;
          parent = parent[index];
        } else {
          if (!parent[key] || typeof parent[key] !== 'object') parent[key] = {};
          parent = parent[key];
        }
      }
      var last = op.path[op.path.length - 1];
      if (Array.isArray(parent) && last.indexOf('@id:') === 0) {
        var itemIndex = arrayIndex(parent, last);
        if (op.op === 'remove') { if (itemIndex >= 0) parent.splice(itemIndex, 1); }
        else if (op.op === 'set') {
          if (itemIndex >= 0) parent[itemIndex] = clone(op.value);
          else parent.push(clone(op.value));
        }
      } else if (op.op === 'remove') delete parent[last];
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
  async function rebaseQueue(remoteState, remoteSeq) {
    return withQueueWriteLock(function () {
      var pending = eligibleQueue();
      if (remoteSeq > 0 && pending.some(function (event) {
        return (event.ops || []).some(function (op) { return op.op === 'replace' && (!op.path || !op.path.length); });
      })) {
        state.syncStatus = 'conflict';
        persistQueue();
        return state.get();
      }
      var merged = clone(remoteState) || {};
      pending.forEach(function (event) { merged = applyLocalOps(merged, event.ops); });
      var rebasedOps = diff(remoteState, merged);
      var preserved = state.queue.filter(function (event) { return pending.indexOf(event) < 0; });
      state.queue = preserved.concat(rebasedOps.length ? [{
        eventId: randomId(), deviceId: deviceId(), accountScope: currentQueueScope(), baseSeq: remoteSeq, baseRevision: revision(),
        ops: rebasedOps, deleteEntities: mergeDeleteEntities(pending), queuedAt: Date.now(), clientAt: Date.now()
      }] : []);
      state.queuedState = clone(merged);
      persistQueue();
      applyRemote(merged, 'rebase');
      return merged;
    });
  }

  async function loginReady(auth, localState) {
    if (!API_BASE || !auth) return;
    await state.queueReady;
    var previousScope = currentQueueScope();
    write(SESSION_KEY, auth);
    var nextScope = accountScope();
    if (nextScope !== previousScope) {
      var currentQueue = state.queue;
      var carry = currentQueue.filter(function (event) { return eventScope(event) === nextScope; });
      var remain = currentQueue.filter(function (event) { return eventScope(event) !== nextScope; });
      persistQueueForScope(previousScope, remain);
      state.queueScope = nextScope;
      state.queue = mergeQueues(readQueueForScope(nextScope), carry);
      state.queueHydrated = false;
      state.queueReady = loadQueueFromIndexedDb(nextScope).then(function () { state.queueHydrated = true; });
      await state.queueReady;
    }
    state.loggedIn = true;
    startPolling();
    state.queuedState = clone(localState);

    var remote = await request('/v1/sync/snapshot');
    var hasRemote = Number(remote.headSeq || 0) > 0;

    if (hasRemote) {
      setHeadSeq(remote.headSeq || 0);
      setRevision(remote.revision == null ? revision() : remote.revision);
      setAcknowledged(remote.state);
      if (state.queue.length) await rebaseQueue(remote.state, remote.headSeq || 0);
      else applyRemote(remote.state, 'login');
      flush();
      return;
    }

    // 云端为空：只在这时把本地数据抬上去
    var hasLocal = !!(localState && (
      (localState.days && Object.keys(localState.days).length) ||
      (localState.reviews && Object.keys(localState.reviews).length) ||
      (localState.template && localState.template.length)
    ));
    var pending = eligibleQueue();
    if (!pending.length && hasLocal) {
      state.queue.push({ eventId: randomId(), deviceId: deviceId(), accountScope: currentQueueScope(), baseSeq: 0, baseRevision: revision(), ops: [{ op: 'replace', path: [], value: clone(localState) }], queuedAt: Date.now(), clientAt: Date.now() });
    }
    setHeadSeq(0);
    persistQueue();
    await flush();
  }

  global.ChronosCloud = {
    enabled: function () { return !!API_BASE; },
    hasSession: function () { return !!read(SESSION_KEY, null); },
    sessionUser: function () {
      var session = read(SESSION_KEY, null);
      return session && session.user || null;
    },
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
      // 退出只清理会话和轮询，保留业务数据及待同步队列，供下次登录继续上传。
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
      var deleteEntities = collectDeletedEntities(before, next);
      if (!ops.length && !deleteEntities.length) return;
      state.queuedState = next;
      withQueueWriteLock(function () {
        state.queue.push({ eventId: randomId(), deviceId: deviceId(), accountScope: currentQueueScope(), baseSeq: headSeq(), baseRevision: revision(), ops: ops, deleteEntities: deleteEntities, status: 'pending', queuedAt: Date.now(), clientAt: Date.now() });
        compactQueue();
        persistQueue();
      }).then(flush).catch(function () { state.syncStatus = 'failed'; });
    },
    init: function (hooks) {
      state.get = hooks.get;
      state.apply = hooks.apply;
      state.getLocalRevision = hooks.getLocalRevision || function () { return 0; };
      state.queueScope = accountScope();
      state.queue = readQueueForScope(state.queueScope);
      adoptQueueScope();
      state.queueHydrated = false;
      state.queueReady = loadQueueFromIndexedDb(state.queueScope).then(function () {
        state.queueHydrated = true;
        if (state.loggedIn && !state.initialSyncInFlight) flush();
      });
      state.queuedState = clone(state.get());
      // 新会话尚无待同步队列时，先固定启动时状态作为本地基线；
      // 远程快照返回后会覆盖为 acknowledged snapshot。已有队列则必须等待远程对账。
      if (!state.queue.length && !acknowledgedState()) setAcknowledged(state.get());
      state.loggedIn = !!read(SESSION_KEY, null);
      state.booted = true;
      if (state.loggedIn) {
        state.initialSyncInFlight = true;
        state.syncStatus = 'pulling';
        // Recover persisted edits before deciding whether a snapshot can replace local state.
        state.queueReady.then(function () { return request('/v1/sync/snapshot'); }).then(async function (remote) {
          if (remote && remote.state) {
            setHeadSeq(remote.headSeq || 0);
            setRevision(remote.revision == null ? revision() : remote.revision);
            setAcknowledged(remote.state);
            if (Number(remote.headSeq || 0) > 0) {
              if (state.queue.length) await rebaseQueue(remote.state, remote.headSeq || 0);
              else applyRemote(remote.state, 'boot');
            }
          }
          state.lastError = null;
          state.lastSyncAt = Date.now();
          state.syncStatus = state.queue.length ? 'pending' : 'idle';
          state.initialSyncInFlight = false;
          flush();
        }).catch(function (e) {
          state.lastError = e && e.code ? String(e.code) : 'cloud_request_failed';
          state.syncStatus = e && (e.code === 'cloud_timeout' || e.code === 'cloud_network') ? 'retrying' : 'failed';
          state.initialSyncInFlight = false;
          flush();
        });
        startPolling();
      }
    },
    isSyncing: function () { return state.syncing || state.pulling; },
    getSyncStatus: function () {
      return {
        status: state.syncStatus,
        error: state.lastError,
        pendingCount: eligibleQueue().length,
        lastSyncAt: state.lastSyncAt,
        retryAttempt: state.retryAttempt,
        nextRetryAt: state.retryTimer ? Date.now() + RETRY_BACKOFF[state.retryAttempt] : null
      };
    },
    devices: async function () { return request('/v1/sync/devices'); },
    revokeDevice: async function (id) { return request('/v1/sync/devices/revoke', { method: 'POST', body: JSON.stringify({ deviceId: id }) }); },
    // 手动同步、应用恢复和网络恢复必须强制拉快照，
    // 避免本地 head 游标异常偏大时只看 head 而永久错过云端状态。
    syncNow: function () { return pullLatest(true); }
  };
  global.addEventListener('online', function () { pullLatest(true); flush(); });
  global.addEventListener('focus', function () { pullLatest(true); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) pullLatest(true); });
})(window);
