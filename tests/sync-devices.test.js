// Sync 2.0 phase 6: device cursor contract.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const MIGRATION = fs.readFileSync('backend/migrations/0006_sync_devices.sql', 'utf8');
const SERVER = fs.readFileSync('backend/src/index.js', 'utf8');
const CLIENT = fs.readFileSync('app/src/main/assets/www/cloud-sync.js', 'utf8');
assert.match(MIGRATION, /CREATE TABLE IF NOT EXISTS sync_devices/i);
assert.match(MIGRATION, /acknowledged_seq/);
assert.match(MIGRATION, /last_seen_at/);
assert.match(MIGRATION, /protocol_version/);
assert.match(SERVER, /sync_devices/);
assert.match(SERVER, /acknowledged_seq/);
assert.match(SERVER, /sync\/ack/);
assert.match(SERVER, /device_id/);
assert.match(CLIENT, /sync\/ack/);
assert.match(CLIENT, /acknowledged|ackServerSeq/);
console.log('✓ sync device cursor contract is present');
