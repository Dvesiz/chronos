import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

function env(overrides = {}) {
  return { APP_ORIGIN: 'https://dvesiz.github.io/chronos', JWT_SECRET: 'test-secret', RESEND_API_KEY: 'test-key', RESEND_FROM_EMAIL: 'system@example.com', ...overrides };
}

test('returns health with allowed CORS origin', async () => {
  const response = await worker.fetch(new Request('https://api.example/health', { headers: { Origin: 'https://dvesiz.github.io/chronos' } }), env());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://dvesiz.github.io/chronos');
  assert.deepEqual(await response.json(), { ok: true, service: 'chronos-api' });
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
