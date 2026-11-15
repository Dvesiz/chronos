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
  assert.match(SERVER, /LEDGER_RETENTION_MS/, '幂等账本必须有明确的保留期限');
  assert.match(SERVER, /DELETE FROM operation_ledger/, '幂等账本必须按保留期限清理');
  const ledgerCheck = SERVER.indexOf('const ledgerEntry =');
  const revisionCheck = SERVER.indexOf('const clientRevision =');
  assert.ok(ledgerCheck >= 0 && revisionCheck > ledgerCheck,
    '重复事件必须先命中幂等账本，再进行 revision 门禁');
  assert.doesNotMatch(SERVER, /const requested = first\.baseRevision[\s\S]{0,220}return json\(\{ error: 'stale_revision'/,
    '批量入口不能在幂等账本之前用第一条事件提前拒绝整批重试');
  console.log('✓ idempotency ledger contract is present');
})();
