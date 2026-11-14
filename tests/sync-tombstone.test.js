// Sync 2.0 phase 4: deletion tombstone contract tests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const MIGRATION = fs.readFileSync('backend/migrations/0005_sync_tombstones.sql', 'utf8');
const SERVER = fs.readFileSync('backend/src/index.js', 'utf8');
const CORE = fs.readFileSync('backend/src/core.js', 'utf8');
const CLIENT = fs.readFileSync('app/src/main/assets/www/cloud-sync.js', 'utf8');

assert.match(MIGRATION, /CREATE TABLE IF NOT EXISTS sync_tombstones/i);
assert.match(MIGRATION, /entity_type/);
assert.match(MIGRATION, /entity_id/);
assert.match(MIGRATION, /delete_revision/);
assert.match(SERVER, /sync_tombstones/);
assert.match(SERVER, /deleteEntities/);
assert.match(SERVER, /INSERT INTO sync_tombstones/);
assert.match(SERVER, /idempotency_key_reused|stale_revision/);
assert.match(CORE, /tombstone|deleted/i);
assert.match(CLIENT, /collectDeletedEntities/);
assert.match(CLIENT, /deleteEntities/);
console.log('✓ deletion tombstone contract is present');
