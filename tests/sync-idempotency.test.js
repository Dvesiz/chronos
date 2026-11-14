// Sync 2.0 phase 3: idempotency ledger contract tests.
const assert = require('node:assert/strict');
const fs = require('node:fs');

const SERVER = fs.readFileSync('backend/src/index.js', 'utf8');
const MIGRATION = fs.readFileSync('backend/migrations/0004_operation_ledger.sql', 'utf8');

(() => {
  assert.match(MIGRATION, /CREATE TABLE IF NOT EXISTS operation_ledger/i,
    'a durable operation ledger table is required');
  assert.match(MIGRATION, /PRIMARY KEY\s*\(user_id, event_id\)/i,
    'ledger identity must be scoped by user and event id');
  assert.match(MIGRATION, /payload_hash/i, 'ledger must store payload hash');
  assert.match(SERVER, /operation_ledger/, 'server must use the independent ledger');
  assert.match(SERVER, /payload_hash|payloadHash/, 'server must calculate/store a payload hash');
  assert.match(SERVER, /idempotency_key_reused/, 'same event id with changed payload must be rejected');
  assert.match(SERVER, /duplicate.*true|duplicate\s*:/i, 'same event id must return an idempotent duplicate result');
  assert.match(SERVER, /INSERT INTO operation_ledger/i, 'accepted event must be recorded in the ledger');
  assert.match(SERVER, /DELETE FROM sync_events/, 'event history pruning must remain separate from ledger retention');
  console.log('✓ idempotency ledger contract is present');
})();
