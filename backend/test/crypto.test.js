import test from 'node:test';
import assert from 'node:assert/strict';
import { randomId, sha256, signToken, verifyToken } from '../src/crypto.js';

test('signs and verifies expiring access tokens', async () => {
  const token = await signToken({ sub: 'u1', sid: 's1', exp: Math.floor(Date.now() / 1000) + 60 }, 'secret');
  const payload = await verifyToken(token, 'secret');
  assert.deepEqual(payload.sub, 'u1');
  assert.equal(await verifyToken(token, 'wrong'), null);
});

test('rejects expired tokens and produces nontrivial ids', async () => {
  const token = await signToken({ sub: 'u1', exp: Math.floor(Date.now() / 1000) - 1 }, 'secret');
  assert.equal(await verifyToken(token, 'secret'), null);
  assert.notEqual(randomId(), randomId());
  assert.equal((await sha256('chronos')).length > 20, true);
});
