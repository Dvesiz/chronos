// Sync 2.0 phase 5: per-event batch result contract.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const SERVER = fs.readFileSync('backend/src/index.js', 'utf8');
const CLIENT = fs.readFileSync('app/src/main/assets/www/cloud-sync.js', 'utf8');
assert.match(SERVER, /results/, 'server response must include per-event results');
assert.match(SERVER, /status.*accepted|accepted.*status/i, 'results must report accepted status');
assert.match(SERVER, /stale_revision|rejected|conflict/, 'results must report failed event status');
assert.match(CLIENT, /results/, 'client must consume per-event results');
assert.match(CLIENT, /accepted|status/, 'client must remove only explicitly accepted events');
console.log('✓ per-event batch result contract is present');
