import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';
import { sha256, signToken } from '../src/crypto.js';

function env(overrides = {}) {
  return { APP_ORIGIN: 'https://dvesiz.github.io/chronos', JWT_SECRET: 'test-secret', RESEND_API_KEY: 'test-key', RESEND_FROM_EMAIL: 'system@example.com', ...overrides };
}

function feedbackDb() {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      calls.push(sql);
      return {
        bind() { return this; },
        async first() { return null; },
        async run() { return { meta: { changes: 1 } }; }
      };
    }
  };
}

test('sync accepts current batches and their retries but rejects a stale device write', async () => {
  const sql = new DatabaseSync(':memory:');
  try {
    const migrations = new URL('../migrations/', import.meta.url);
    for (const name of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
      sql.exec(readFileSync(new URL(name, migrations), 'utf8'));
    }
    sql.exec(`INSERT INTO users (id,email,created_at,updated_at) VALUES ('user','u@example.com',1,1);
      INSERT INTO sessions (id,user_id,device_id,refresh_hash,expires_at,created_at,last_seen_at)
      VALUES ('session','user','web','hash',9999999999999,1,1);
      INSERT INTO sync_documents (user_id,state_json,head_seq,revision,updated_at)
      VALUES ('user','{}',10,0,1);`);
    const db = {
      prepare(query) {
        const stmt = sql.prepare(query);
        return { bind(...args) {
          return { first: async () => stmt.get(...args), run: async () => ({ meta: stmt.run(...args) }) };
        } };
      },
      async batch(statements) {
        sql.exec('BEGIN');
        try {
          const result = [];
          for (const stmt of statements) result.push(await stmt.run());
          sql.exec('COMMIT');
          return result;
        } catch (err) { sql.exec('ROLLBACK'); throw err; }
      }
    };
    const config = env({ DB: db });
    const jwt = await signToken({ sub: 'user', sid: 'session', exp: Math.floor(Date.now() / 1000) + 60 }, config.JWT_SECRET);
    const event = (eventId, value, deviceId = 'web') => ({ eventId, deviceId, baseSeq: 10, baseRevision: 0, ops: [{ op: 'set', path: ['theme'], value }] });
    const post = async events => {
      const res = await worker.fetch(new Request('https://api.example/v1/sync/events', {
        method: 'POST', headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
        body: JSON.stringify({ protocolVersion: 2, accountScope: 'user', baseRevision: 0, events })
      }), config);
      assert.equal(res.status, 200);
      return res.json();
    };
    const web = [event('w1', 'light'), event('w2', 'dark')];
    assert.equal((await post(web.slice(0, 1))).revision, 1);
    assert.equal((await post(web)).revision, 2, 'a duplicate prefix advances by business revision, not event sequence');
    const retry = await post(web);
    assert.equal(retry.revision, 2);
    assert.ok(retry.results.every(item => item.duplicate));
    const stale = await post([web[0], event('a1', 'light', 'android')]);
    assert.equal(stale.results[1].error, 'stale_revision');
    assert.equal(stale.revision, 2);
    assert.equal(stale.state.theme, 'dark');
  } finally { sql.close(); }
});

test('续期写入暂时失败后，现有会话仍可重试续期', async () => {
  const sql = new DatabaseSync(':memory:');
  try {
    for (const migration of ['0001_initial.sql', '0002_avatar_data.sql', '0003_revision.sql']) {
      sql.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
    }
    sql.exec("INSERT INTO users (id,email,created_at,updated_at) VALUES ('user','u@example.com',1,1)");
    const token = 'local-test-refresh';
    sql.prepare('INSERT INTO sessions (id,user_id,device_id,refresh_hash,expires_at,created_at,last_seen_at) VALUES (?,?,?,?,?,?,?)')
      .run('session', 'user', 'android', await sha256(token), Date.now() + 60000, 1, 1);
    let failWrite = true;
    const config = env({ DB: {
      prepare(query) {
        const stmt = sql.prepare(query);
        return { bind(...args) {
          return {
            first: async () => stmt.get(...args),
            run: async () => {
              if (failWrite && /INSERT INTO sessions|UPDATE sessions SET refresh_hash/.test(query)) throw new Error('续期写入暂时失败');
              return { meta: stmt.run(...args) };
            }
          };
        } };
      }
    } });
    const refresh = refreshToken => worker.fetch(new Request('https://api.example/v1/auth/refresh', {
      method: 'POST', body: JSON.stringify({ refreshToken })
    }), config);
    const head = accessToken => worker.fetch(new Request('https://api.example/v1/sync/head', {
      headers: { authorization: `Bearer ${accessToken}` }
    }), config);
    const oldAccess = await signToken({ sub: 'user', sid: 'session', exp: Math.floor(Date.now() / 1000) + 60 }, config.JWT_SECRET);
    assert.equal((await refresh(token)).status, 500);
    assert.equal((await head(oldAccess)).status, 200);
    failWrite = false;
    const retried = await refresh(token);
    assert.equal(retried.status, 200);
    const session = await retried.json();
    assert.notEqual(session.refreshToken, token);
    assert.equal((await refresh(token)).status, 401);
    const authorized = await worker.fetch(new Request('https://api.example/v1/sync/head', {
      headers: { authorization: `Bearer ${session.accessToken}` }
    }), config);
    assert.equal(authorized.status, 200);
  } finally { sql.close(); }
});

test('returns health with allowed CORS origin', async () => {
  const response = await worker.fetch(new Request('https://api.example/health', { headers: { Origin: 'https://dvesiz.github.io/chronos' } }), env());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://dvesiz.github.io/chronos');
  assert.deepEqual(await response.json(), { ok: true, service: 'chronos-api' });
});

test('allows null origin for the Android file WebView', async () => {
  const response = await worker.fetch(new Request('https://api.example/v1/auth/send-code', { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } }), env());
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), 'null');
});

test('returns a client error for malformed JSON', async () => {
  const response = await worker.fetch(new Request('https://api.example/v1/auth/send-code', { method: 'POST', body: '{bad', headers: { Origin: 'https://dvesiz.github.io/chronos', 'content-type': 'application/json' } }), env());
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'json_invalid');
});

test('sends a styled verification email with a plain text fallback', async () => {
  const db = feedbackDb();
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    sent.push({ url, options });
    return new Response('{}', { status: 200 });
  };
  try {
    const response = await worker.fetch(new Request('https://api.example/v1/auth/send-code', {
      method: 'POST',
      headers: { Origin: 'https://dvesiz.github.io/chronos', 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'USER@example.com' })
    }), env({ DB: db }));
    assert.equal(response.status, 200);
    assert.equal(sent.length, 1);
    const mail = JSON.parse(sent[0].options.body);
    assert.deepEqual(mail.to, ['user@example.com']);
    assert.equal(mail.subject, '时序 Chronos · 登录验证码');
    const code = mail.text.match(/\d{6}/)?.[0];
    assert.ok(code);
    assert.match(mail.html, new RegExp(`>${code}<`));
    assert.match(mail.html, /10 分钟内有效/);
    assert.match(mail.text, new RegExp(`你的验证码：${code}`));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('handles CORS preflight and rejects unauthenticated sync', async () => {
  const preflight = await worker.fetch(new Request('https://api.example/v1/sync/snapshot', { method: 'OPTIONS', headers: { Origin: 'https://dvesiz.github.io/chronos' } }), env());
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-methods'), /PATCH/);
  const response = await worker.fetch(new Request('https://api.example/v1/sync/snapshot'), env());
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'unauthorized');
});

test('notifies the owner after storing feedback', async () => {
  const db = feedbackDb();
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    sent.push({ url, options });
    return new Response('{}', { status: 200 });
  };
  try {
    const response = await worker.fetch(new Request('https://api.example/v1/feedback', {
      method: 'POST',
      headers: { Origin: 'https://dvesiz.github.io/chronos', 'content-type': 'application/json' },
      body: JSON.stringify({ body: '<script>alert("x")</script>\n同步反馈', email: 'user@example.com', appVersion: '2.7.1' })
    }), env({ DB: db, FEEDBACK_TO_EMAIL: 'owner@example.com' }));
    assert.equal(response.status, 201);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, 'https://api.resend.com/emails');
    const mail = JSON.parse(sent[0].options.body);
    assert.deepEqual(mail.to, ['owner@example.com']);
    assert.match(mail.text, /同步反馈/);
    assert.match(mail.html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
    assert.doesNotMatch(mail.html, /<script>alert\("x"\)<\/script>/);
    assert.match(mail.html, /2\.7\.1/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
