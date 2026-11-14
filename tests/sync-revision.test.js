// Sync 2.0 revision protocol regression tests.
// These contract checks protect the wire/database boundary until the Worker
// integration harness has a D1 transaction fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');

const SERVER = fs.readFileSync('backend/src/index.js', 'utf8');
const CLIENT = fs.readFileSync('app/src/main/assets/www/cloud-sync.js', 'utf8');
const MIGRATION = fs.readFileSync('backend/migrations/0003_revision.sql', 'utf8');

(() => {
  assert.match(MIGRATION, /ALTER TABLE sync_documents ADD COLUMN revision INTEGER NOT NULL DEFAULT 0/,
    'migration must add an independent revision column');

  assert.match(SERVER, /stale_revision/, 'server must expose stale_revision');
  assert.match(SERVER, /currentRevision/, 'stale response must include currentRevision');
  assert.match(SERVER, /baseRevision/, 'server must consume batch baseRevision');
  assert.match(SERVER, /revision\s*[:=]/, 'server must read or return revision');
  assert.match(SERVER, /revision\s*=\s*revision\s*\+\s*1|revision\s*\+\s*1|revision\+1/,
    'successful business commits must increment revision');
  assert.match(SERVER, /409/, 'stale revision must be a conflict response');

  assert.match(CLIENT, /baseRevision/, 'client uploads must carry baseRevision');
  assert.match(CLIENT, /stale_revision/, 'client must recognize stale_revision');
  assert.match(CLIENT, /revision/, 'client must persist/read remote revision');

  console.log('✓ revision/stale_revision contract is present');
})();
