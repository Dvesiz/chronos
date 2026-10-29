import { applyOps, compactState, DEFAULT_STATE, diffState, validateAvatarData, validateEmail, validateEvent, validateStateSize } from './core.js';
import { hmac, randomId, sha256, signToken, verifyToken } from './crypto.js';
import { requireConfig } from './config.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const MAX_BODY = 1024 * 1024;
const CODE_TTL = 10 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
const EMAIL_WINDOW = 15 * 60 * 1000;
const EMAIL_LIMIT = 3;
const ACCESS_TTL = 15 * 60;
const REFRESH_TTL = 30 * 24 * 60 * 60;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
}
function error(code, status, message = code) { return json({ error: code, message }, status); }
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function withCors(response, cors) {
  const headers = new Headers(response.headers);
  Object.entries(cors).forEach(([key, value]) => headers.set(key, value));
  return new Response(response.body, { status: response.status, headers });
}
function now() { return Date.now(); }
function originAllowed(origin, env) {
  if (!origin) return false;
  const allowed = new Set([
    env.APP_ORIGIN,
    `${env.APP_ORIGIN}/`,
    'https://dvesiz.github.io',
    'http://localhost:8787',
    'http://127.0.0.1:8787'
  ].filter(Boolean));
  return origin === 'null' || allowed.has(origin);
}
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  return originAllowed(origin, env) ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type, authorization, x-device-id', 'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS', 'vary': 'Origin' } : {};
}
async function bodyJson(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_BODY) throw new Error('body_too_large');
  const text = await request.text();
  if (text.length > MAX_BODY) throw new Error('body_too_large');
  try { return JSON.parse(text || '{}'); }
  catch { throw new Error('json_invalid'); }
}
function clientIp(request) { return request.headers.get('CF-Connecting-IP') || 'unknown'; }
function clientKey(request, email = '') { return `${clientIp(request)}:${email}`; }
async function limited(env, key, limit, windowMs) {
  const current = now();
  const row = await env.DB.prepare('SELECT * FROM rate_limits WHERE rate_key=?').bind(key).first();
  if (!row || current - row.window_started_at >= windowMs) {
    await env.DB.prepare('INSERT INTO rate_limits (rate_key,window_started_at,count) VALUES (?,?,1) ON CONFLICT(rate_key) DO UPDATE SET window_started_at=excluded.window_started_at,count=1').bind(key, current).run();
    return true;
  }
  if (row.count >= limit) return false;
  await env.DB.prepare('UPDATE rate_limits SET count=count+1 WHERE rate_key=?').bind(key).run();
  return true;
}
async function hashCode(email, code, env) { return sha256(`${email}:${code}:${jwtSecret(env)}`); }
function jwtSecret(env) {
  if (!env.JWT_SECRET) throw new Error('JWT_SECRET_NOT_CONFIGURED');
  return env.JWT_SECRET;
}

async function getUser(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const payload = await verifyToken(token, jwtSecret(env));
  if (!payload?.sid || !payload?.sub) return null;
  const row = await env.DB.prepare('SELECT s.*, u.email, u.nickname, u.avatar, u.avatar_data FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.user_id=? AND s.revoked_at IS NULL AND s.expires_at>?').bind(payload.sid, payload.sub, now()).first();
  if (!row) return null;
  return { id: row.user_id, email: row.email, nickname: row.nickname, avatar: row.avatar, avatarData: row.avatar_data || '', sessionId: row.id, deviceId: row.device_id };
}
async function createSession(user, deviceId, env) {
  const issued = Math.floor(now() / 1000);
  const sid = randomId();
  const refresh = randomId(32);
  await env.DB.prepare('INSERT INTO sessions (id,user_id,device_id,refresh_hash,expires_at,created_at,last_seen_at) VALUES (?,?,?,?,?,?,?)')
    .bind(sid, user.id, deviceId, await sha256(refresh), now() + REFRESH_TTL * 1000, now(), now()).run();
  const access = await signToken({ sub: user.id, sid, exp: issued + ACCESS_TTL }, jwtSecret(env));
  return { accessToken: access, refreshToken: refresh, expiresIn: ACCESS_TTL, user: { id: user.id, email: user.email, nickname: user.nickname, avatar: user.avatar, avatarData: user.avatarData || '' } };
}

async function sendCode(request, env) {
  const data = await bodyJson(request);
  const email = String(data.email || '').trim().toLowerCase();
  if (!validateEmail(email)) return error('email_invalid', 400, '请输入有效的邮箱地址');
  if (!(await limited(env, clientKey(request, email), EMAIL_LIMIT, EMAIL_WINDOW))
    || !(await limited(env, `ip:${clientIp(request)}`, EMAIL_LIMIT * 2, EMAIL_WINDOW))) {
    return error('rate_limited', 429, '请求过于频繁，请稍后再试');
  }
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  const code = String(100000 + (random[0] % 900000));
  const id = randomId();
  await env.DB.prepare('DELETE FROM auth_codes WHERE email=? OR expires_at<?').bind(email, now()).run();
  await env.DB.prepare('INSERT INTO auth_codes (id,email,code_hash,expires_at,attempts,created_at) VALUES (?,?,?,?,0,?)').bind(id, email, await hashCode(email, code, env), now() + CODE_TTL, now()).run();
  const subject = '\u65f6\u5e8f Chronos \u00b7 \u767b\u5f55\u9a8c\u8bc1\u7801';
  const text = `\u65f6\u5e8f Chronos \u767b\u5f55\u9a8c\u8bc1\u7801\n\n\u4f60\u7684\u9a8c\u8bc1\u7801\uff1a${code}\n\n\u6b64\u9a8c\u8bc1\u7801\u5c06\u5728 10 \u5206\u949f\u540e\u5931\u6548\u3002\u82e5\u975e\u672c\u4eba\u64cd\u4f5c\uff0c\u8bf7\u5ffd\u7565\u6b64\u90ae\u4ef6\u3002`;
  const html = `
    <!doctype html>
    <html lang="zh-CN">
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
      <body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#202124;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f3f4f6;">
          <tr><td align="center" style="padding:36px 16px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;">
              <tr><td style="padding:0 0 16px 4px;font-size:14px;font-weight:700;color:#24262a;">\u65f6\u5e8f <span style="font-weight:400;color:#777b82;">CHRONOS</span></td></tr>
              <tr><td style="padding:32px 28px;background-color:#ffffff;border:1px solid #e7e8eb;border-radius:12px;">
                <p style="margin:0 0 12px;font-size:12px;line-height:18px;font-weight:700;letter-spacing:1px;color:#ff5a1f;">\u767b\u5f55\u5b89\u5168\u9a8c\u8bc1</p>
                <h1 style="margin:0 0 10px;font-size:24px;line-height:32px;font-weight:700;color:#202124;">\u4f60\u7684\u767b\u5f55\u9a8c\u8bc1\u7801</h1>
                <p style="margin:0;font-size:14px;line-height:22px;color:#62666d;">\u4f7f\u7528\u4e0b\u65b9\u9a8c\u8bc1\u7801\u5b8c\u6210\u767b\u5f55\u3002</p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 20px;background-color:#fff5f0;border:1px solid #ffe1d3;border-radius:8px;">
                  <tr><td align="center" style="padding:20px 12px;font-size:34px;line-height:42px;font-weight:700;letter-spacing:8px;color:#ff5a1f;">${code}</td></tr>
                </table>
                <p style="margin:0;font-size:13px;line-height:21px;color:#62666d;">\u9a8c\u8bc1\u7801 <strong style="color:#35383d;">10 \u5206\u949f\u5185\u6709\u6548</strong>，\u8bf7\u52ff\u8f6c\u53d1\u7ed9\u4ed6\u4eba\u3002</p>
                <p style="margin:16px 0 0;font-size:13px;line-height:21px;color:#8a8e95;">\u5982\u679c\u8fd9\u4e0d\u662f\u4f60\u53d1\u8d77\u7684\u64cd\u4f5c，\u53ef\u4ee5\u5ffd\u7565\u6b64\u90ae\u4ef6\u3002</p>
              </td></tr>
              <tr><td align="center" style="padding:18px 12px 0;font-size:12px;line-height:18px;color:#969aa1;">\u6b64\u90ae\u4ef6\u7531\u65f6\u5e8f Chronos \u81ea\u52a8\u53d1\u9001，\u8bf7\u52ff\u76f4\u63a5\u56de\u590d\u3002</td></tr>
            </table>
          </td></tr>
        </table>
      </body>
    </html>`;
  const mail = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.RESEND_FROM_EMAIL, to: [email], subject, html, text })
  });
  if (!mail.ok) { await env.DB.prepare('DELETE FROM auth_codes WHERE id=?').bind(id).run(); return error('email_send_failed', 502, '验证码发送失败，请稍后重试'); }
  return json({ ok: true, expiresIn: CODE_TTL / 1000 });
}

async function verifyCode(request, env) {
  const data = await bodyJson(request);
  const email = String(data.email || '').trim().toLowerCase();
  const code = String(data.code || '').trim();
  const deviceId = String(data.deviceId || '').trim().slice(0, 128) || randomId();
  if (!validateEmail(email) || !/^\d{6}$/.test(code)) return error('code_invalid', 400, '验证码不正确或已过期');
  const row = await env.DB.prepare('SELECT * FROM auth_codes WHERE email=? ORDER BY created_at DESC LIMIT 1').bind(email).first();
  if (!row || row.expires_at < now() || row.attempts >= MAX_CODE_ATTEMPTS) return error('code_invalid', 401, '验证码不正确或已过期');
  const hash = await hashCode(email, code, env);
  if (hash !== row.code_hash) { await env.DB.prepare('UPDATE auth_codes SET attempts=attempts+1 WHERE id=?').bind(row.id).run(); return error('code_invalid', 401, '验证码不正确或已过期'); }
  await env.DB.prepare('DELETE FROM auth_codes WHERE id=?').bind(row.id).run();
  const current = now();
  let user = await env.DB.prepare('SELECT * FROM users WHERE email=?').bind(email).first();
  if (!user) { const id = randomId(); await env.DB.prepare('INSERT INTO users (id,email,created_at,updated_at) VALUES (?,?,?,?)').bind(id, email, current, current).run(); user = { id, email, nickname: '', avatar: 0, avatarData: '' }; }
  else user = { id: user.id, email: user.email, nickname: user.nickname, avatar: user.avatar, avatarData: user.avatar_data || '' };
  return json(await createSession(user, deviceId, env));
}

async function refresh(request, env) {
  const data = await bodyJson(request);
  const tokenHash = await sha256(String(data.refreshToken || ''));
  const row = await env.DB.prepare('SELECT s.*,u.email,u.nickname,u.avatar,u.avatar_data FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.refresh_hash=? AND s.revoked_at IS NULL AND s.expires_at>?').bind(tokenHash, now()).first();
  if (!row) return error('refresh_invalid', 401, '登录已失效，请重新登录');
  await env.DB.prepare('UPDATE sessions SET revoked_at=?,last_seen_at=? WHERE id=?').bind(now(), now(), row.id).run();
  return json(await createSession({ id: row.user_id, email: row.email, nickname: row.nickname, avatar: row.avatar, avatarData: row.avatar_data || '' }, row.device_id, env));
}

async function appendEventWithCas(env, user, event) {
  await env.DB.prepare('INSERT OR IGNORE INTO sync_documents (user_id,state_json,head_seq,updated_at) VALUES (?,?,?,?)')
    .bind(user.id, JSON.stringify(compactState(DEFAULT_STATE)), 0, now()).run();

  for (let attempt = 0; attempt < 4; attempt++) {
    const document = await env.DB.prepare('SELECT state_json,head_seq FROM sync_documents WHERE user_id=?').bind(user.id).first();
    const state = JSON.parse(document.state_json);
    if (!validateStateSize(state)) throw new Error('state_too_large');
    const nextState = applyOps(state, event.ops);
    if (!validateStateSize(nextState)) throw new Error('state_too_large');
    const duplicate = await env.DB.prepare('SELECT server_seq FROM sync_events WHERE user_id=? AND event_id=?').bind(user.id, event.eventId).first();
    if (duplicate) return { state, headSeq: document.head_seq, serverSeq: duplicate.server_seq, duplicate: true };
    const createdAt = now();
    const serverSeq = Number(document.head_seq || 0) + 1;
    try {
      const batch = await env.DB.batch([
        env.DB.prepare('INSERT INTO sync_events (user_id,server_seq,event_id,device_id,base_seq,ops_json,client_at,created_at) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM sync_documents WHERE user_id=? AND head_seq=?)')
          .bind(user.id, serverSeq, event.eventId, event.deviceId, event.baseSeq, JSON.stringify(event.ops), event.clientAt || null, createdAt, user.id, document.head_seq),
        env.DB.prepare('UPDATE sync_documents SET state_json=?,head_seq=?,updated_at=? WHERE user_id=? AND head_seq=?')
          .bind(JSON.stringify(nextState), serverSeq, createdAt, user.id, document.head_seq)
      ]);
      if (batch[0].meta.changes !== 1 || batch[1].meta.changes !== 1) continue;
      return { state: nextState, headSeq: serverSeq, serverSeq, duplicate: false };
    } catch (err) {
      /* Same user sequence was claimed concurrently; the next attempt reads the new snapshot. */
    }
  }
  throw new Error('sync_conflict');
}

async function syncEvents(request, env, user) {
  const data = await bodyJson(request);
  const events = Array.isArray(data.events) ? data.events : [];
  if (events.length > 50) return error('events_too_many', 400);
  const accepted = [];
  let state = compactState(DEFAULT_STATE);
  let headSeq = 0;
  for (const event of events) {
    const checked = validateEvent(event);
    if (!checked.ok) return error(checked.error, 400);
    try {
      const result = await appendEventWithCas(env, user, event);
      state = result.state;
      headSeq = result.headSeq;
      accepted.push({ eventId: event.eventId, serverSeq: result.serverSeq, duplicate: result.duplicate });
    } catch (err) {
      if (err?.message === 'state_too_large') return error('state_too_large', 413);
      if (err?.message === 'sync_conflict') return error('sync_conflict', 409, '云端正在同步，请稍后重试');
      throw err;
    }
  }
  const document = await env.DB.prepare('SELECT state_json,head_seq FROM sync_documents WHERE user_id=?').bind(user.id).first();
  if (document) { state = JSON.parse(document.state_json); headSeq = document.head_seq; }
  return json({ ok: true, headSeq, accepted, state });
}

async function syncSnapshot(env, user) {
  const row = await env.DB.prepare('SELECT state_json,head_seq,updated_at FROM sync_documents WHERE user_id=?').bind(user.id).first();
  return json({ state: row ? JSON.parse(row.state_json) : compactState(DEFAULT_STATE), headSeq: row?.head_seq || 0, updatedAt: row?.updated_at || null });
}
async function syncHead(env, user) {
  const row = await env.DB.prepare('SELECT head_seq,updated_at FROM sync_documents WHERE user_id=?').bind(user.id).first();
  return json({ headSeq: row?.head_seq || 0, updatedAt: row?.updated_at || null });
}
async function syncHistory(request, env, user) {
  const after = Math.max(0, Number(new URL(request.url).searchParams.get('after') || 0));
  const rows = await env.DB.prepare('SELECT server_seq,event_id,device_id,base_seq,ops_json,client_at,created_at FROM sync_events WHERE user_id=? AND server_seq>? ORDER BY server_seq LIMIT 500').bind(user.id, after).all();
  return json({ events: rows.results.map(row => ({ ...row, ops: JSON.parse(row.ops_json) })) });
}
async function profile(request, env, user) {
  const data = await bodyJson(request);
  const nickname = String(data.nickname || '').trim().slice(0, 32);
  const avatar = Number.isInteger(data.avatar) ? Math.max(0, Math.min(31, data.avatar)) : 0;
  const avatarData = data.avatarData || '';
  if (!validateAvatarData(avatarData)) return error('avatar_invalid', 400, '头像格式不支持或文件过大');
  await env.DB.prepare('UPDATE users SET nickname=?,avatar=?,avatar_data=?,updated_at=? WHERE id=?').bind(nickname, avatar, avatarData, now(), user.id).run();
  return json({ user: { id: user.id, email: user.email, nickname, avatar, avatarData } });
}
async function deleteAccount(env, user) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sync_events WHERE user_id=?').bind(user.id),
    env.DB.prepare('DELETE FROM sync_documents WHERE user_id=?').bind(user.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(user.id),
    env.DB.prepare('DELETE FROM auth_codes WHERE email=?').bind(user.email),
    env.DB.prepare('DELETE FROM feedback WHERE user_id=?').bind(user.id),
    env.DB.prepare('DELETE FROM users WHERE id=?').bind(user.id)
  ]);
  return json({ ok: true });
}
async function notifyFeedback(env, feedback) {
  const to = String(env.FEEDBACK_TO_EMAIL || '').trim();
  if (!to) return false;
  const subject = `Chronos 新反馈 · ${feedback.appVersion || '未知版本'}`;
  const details = [
    ['用户邮箱', feedback.email || '未提供'],
    ['用户 ID', feedback.userId || '未登录'],
    ['应用版本', feedback.appVersion || '未知'],
    ['反馈类型', feedback.kind]
  ];
  const text = [
    `反馈内容：${feedback.body}`,
    ...details.map(([label, value]) => `${label}：${value}`)
  ].join('\n');
  const htmlDetails = details.map(([label, value]) => `
    <tr>
      <td style="width:104px;padding:11px 12px 11px 0;border-top:1px solid #eceef0;font-size:13px;line-height:20px;color:#858990;vertical-align:top;">${escapeHtml(label)}</td>
      <td style="padding:11px 0;border-top:1px solid #eceef0;font-size:13px;line-height:20px;color:#35383d;word-break:break-word;vertical-align:top;">${escapeHtml(value)}</td>
    </tr>`).join('');
  const htmlBody = escapeHtml(feedback.body).replace(/\r?\n/g, '<br>');
  const html = `
    <!doctype html>
    <html lang="zh-CN">
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
      <body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#202124;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f3f4f6;">
          <tr><td align="center" style="padding:36px 16px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
              <tr><td style="padding:0 0 16px 4px;font-size:14px;font-weight:700;color:#24262a;">时序 <span style="font-weight:400;color:#777b82;">CHRONOS</span></td></tr>
              <tr><td style="padding:30px 28px;background-color:#ffffff;border:1px solid #e7e8eb;border-radius:12px;">
                <p style="margin:0 0 12px;font-size:12px;line-height:18px;font-weight:700;letter-spacing:1px;color:#ff5a1f;">产品反馈</p>
                <h1 style="margin:0 0 8px;font-size:23px;line-height:31px;font-weight:700;color:#202124;">收到一条新反馈</h1>
                <p style="margin:0;font-size:14px;line-height:22px;color:#777b82;">Chronos 用户提交了新的反馈，请查看内容与相关信息。</p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 22px;background-color:#f7f8f9;border:1px solid #eceef0;border-radius:8px;">
                  <tr><td style="padding:18px 20px;font-size:14px;line-height:23px;color:#303238;word-break:break-word;">${htmlBody}</td></tr>
                </table>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  ${htmlDetails}
                </table>
              </td></tr>
              <tr><td align="center" style="padding:18px 12px 0;font-size:12px;line-height:18px;color:#969aa1;">此通知由时序 Chronos 自动发送。</td></tr>
            </table>
          </td></tr>
        </table>
      </body>
    </html>`;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.RESEND_FROM_EMAIL, to: [to], subject, html, text })
  });
  return response.ok;
}
async function feedback(request, env, user) {
  const data = await bodyJson(request);
  if (!(await limited(env, `feedback:${clientIp(request)}`, 10, 15 * 60 * 1000))) return error('rate_limited', 429, '提交过于频繁，请稍后再试');
  const body = String(data.body || '').trim();
  if (!body || body.length > 4000) return error('feedback_invalid', 400, '反馈内容不能为空且不能超过 4000 字');
  const feedback = {
    userId: user?.id || null,
    email: user?.email || String(data.email || '').slice(0, 254) || null,
    kind: String(data.kind || 'general').slice(0, 32),
    body,
    appVersion: String(data.appVersion || '').slice(0, 32)
  };
  await env.DB.prepare('INSERT INTO feedback (id,user_id,email,kind,body,app_version,created_at) VALUES (?,?,?,?,?,?,?)')
    .bind(randomId(), feedback.userId, feedback.email, feedback.kind, feedback.body, feedback.appVersion, now()).run();
  try {
    const notified = await notifyFeedback(env, feedback);
    if (!notified) console.error('feedback_notification_failed');
  } catch (err) {
    console.error('feedback_notification_failed', err);
  }
  return json({ ok: true }, 201);
}
async function latest(env) {
  const row = await env.DB.prepare('SELECT version,url,notes,published_at AS publishedAt,mandatory FROM app_releases ORDER BY published_at DESC LIMIT 1').first();
  return json({ release: row || null });
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'access-control-max-age': '86400' } });
    const url = new URL(request.url);
    if (url.pathname === '/health') return withCors(json({ ok: true, service: 'chronos-api' }), cors);
    try {
      requireConfig(env);
      if (url.pathname === '/v1/auth/send-code' && request.method === 'POST') return withCors(await sendCode(request, env), cors);
      if (url.pathname === '/v1/auth/verify' && request.method === 'POST') return withCors(await verifyCode(request, env), cors);
      if (url.pathname === '/v1/auth/refresh' && request.method === 'POST') return withCors(await refresh(request, env), cors);
      if (url.pathname === '/v1/app/latest' && request.method === 'GET') return withCors(await latest(env), cors);
      if (url.pathname === '/v1/feedback' && request.method === 'POST') return withCors(await feedback(request, env, await getUser(request, env)), cors);
      const user = await getUser(request, env);
      if (!user) return withCors(error('unauthorized', 401, '请先登录'), cors);
      if (url.pathname === '/v1/account/profile' && request.method === 'PATCH') return withCors(await profile(request, env, user), cors);
      if (url.pathname === '/v1/account/delete' && request.method === 'DELETE') return withCors(await deleteAccount(env, user), cors);
      if (url.pathname === '/v1/auth/logout' && request.method === 'POST') { await env.DB.prepare('UPDATE sessions SET revoked_at=? WHERE id=?').bind(now(), user.sessionId).run(); return withCors(json({ ok: true }), cors); }
      if (url.pathname === '/v1/sync/events' && request.method === 'POST') return withCors(await syncEvents(request, env, user), cors);
      if (url.pathname === '/v1/sync/snapshot' && request.method === 'GET') return withCors(await syncSnapshot(env, user), cors);
      if (url.pathname === '/v1/sync/head' && request.method === 'GET') return withCors(await syncHead(env, user), cors);
      if (url.pathname === '/v1/sync/events' && request.method === 'GET') return withCors(await syncHistory(request, env, user), cors);
      return withCors(error('not_found', 404), cors);
    } catch (err) {
      if (err?.message === 'body_too_large') return withCors(error('body_too_large', 413), cors);
      if (err?.message === 'json_invalid') return withCors(error('json_invalid', 400, '请求格式不正确'), cors);
      if (err?.message?.startsWith('missing_config:') || err?.message === 'JWT_SECRET_NOT_CONFIGURED') return withCors(error('server_not_configured', 503, '服务端尚未完成安全配置'), cors);
      console.error(err);
      return withCors(error('internal_error', 500), cors);
    }
  }
};
