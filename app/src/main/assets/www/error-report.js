/* Chronos 前端错误上报：只抓崩溃与未处理的 Promise，不做埋点。
 *
 * 设计约束：
 *  - 绝不影响主流程：任何一环抛错都静默吞掉；
 *  - 不打点、不采集用户内容：只上报错误类型/消息/堆栈/版本/页面；
 *  - 同一错误去重 + 限频，避免死循环刷爆 /v1/feedback；
 *  - 未配置后端或未登录时完全不工作（本地优先原则）。
 */
(function (global) {
  'use strict';

  var MAX_REPORTS = 5;          // 每次会话最多上报几条
  var DEDUPE_MS = 10 * 60 * 1000; // 同一错误 10 分钟内只报一次
  // 版本号由 cloud-config.js 统一提供（与 AndroidManifest 的 versionName 同源）
  var APP_VERSION = String(global.CHRONOS_APP_VERSION || 'dev');

  var sent = 0;
  var seen = {};

  function apiBase() {
    return String(global.CHRONOS_API_BASE || '').replace(/\/$/, '');
  }

  function hasSession() {
    try {
      return !!JSON.parse(localStorage.getItem('chronos.cloud.session.v1') || 'null');
    } catch (e) { return false; }
  }

  function enabled() {
    return !!apiBase() && hasSession();
  }

  /** 错误指纹：同类型同消息同位置视为同一条 */
  function fingerprint(kind, message, where) {
    return kind + '|' + String(message).slice(0, 160) + '|' + String(where || '').slice(0, 120);
  }

  function shouldSend(kind, message, where) {
    if (!enabled()) return false;
    if (sent >= MAX_REPORTS) return false;
    var key = fingerprint(kind, message, where);
    var now = Date.now();
    if (seen[key] && now - seen[key] < DEDUPE_MS) return false;
    seen[key] = now;
    return true;
  }

  function describe(err, kind) {
    if (!err) return { message: '(unknown)', stack: '' };
    if (typeof err === 'string') return { message: err, stack: '' };
    return {
      message: String(err.message || err.name || '(no message)'),
      stack: String(err.stack || '')
    };
  }

  function report(kind, err, extra) {
    try {
      var d = describe(err, kind);
      var where = extra && extra.where || '';
      if (!shouldSend(kind, d.message, where)) return;
      sent++;

      var lines = [
        '[client] ' + kind,
        'version: ' + APP_VERSION,
        'page: ' + (location && location.pathname || ''),
        'time: ' + new Date().toISOString(),
        'message: ' + d.message
      ];
      if (where) lines.push('where: ' + where);
      if (d.stack) lines.push('stack:\n' + d.stack.slice(0, 1200));
      if (extra && extra.detail) lines.push('detail: ' + String(extra.detail).slice(0, 400));

      var body = JSON.stringify({
        kind: 'crash',
        appVersion: APP_VERSION,
        body: lines.join('\n')
      });

      // 用 keepalive，页面正在崩溃/关闭时也能尽量发出去
      fetch(apiBase() + '/v1/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body,
        keepalive: true
      }).catch(function () { /* 上报失败就算了，绝不打扰用户 */ });
    } catch (e) {
      /* 上报自身出错也必须静默 */
    }
  }

  // 1) 未捕获异常
  global.addEventListener('error', function (event) {
    try {
      var err = event && (event.error || event.message);
      report('uncaught', err, {
        where: event && event.filename ? event.filename + ':' + event.lineno : '',
        detail: event && event.colno != null ? 'col ' + event.colno : ''
      });
    } catch (e) {}
  });

  // 2) 未处理的 Promise 拒绝（异步失败最常见）
  global.addEventListener('unhandledrejection', function (event) {
    try {
      var reason = event && event.reason;
      report('unhandledrejection', reason, { where: 'promise' });
    } catch (e) {}
  });

  // 3) 手动上报入口，供关键失败点主动调用
  global.ChronosReport = {
    report: function (kind, err, extra) { report(kind || 'manual', err, extra || {}); },
    enabled: enabled
  };
})(window);
