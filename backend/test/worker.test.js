import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

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
      body: JSON.stringify({ body: '同步反馈', email: 'user@example.com', appVersion: '2.7.1' })
    }), env({ DB: db, FEEDBACK_TO_EMAIL: 'owner@example.com' }));
    assert.equal(response.status, 201);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, 'https://api.resend.com/emails');
    const mail = JSON.parse(sent[0].options.body);
    assert.deepEqual(mail.to, ['owner@example.com']);
    assert.match(mail.text, /同步反馈/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
