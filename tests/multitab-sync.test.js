const assert = require('node:assert/strict');
const fs = require('node:fs');
const SRC = fs.readFileSync('app/src/main/assets/www/cloud-sync.js', 'utf8');
assert.match(SRC, /BroadcastChannel/, 'cloud sync should coordinate same-origin tabs');
assert.match(SRC, /postMessage/, 'tab updates should be broadcast');
assert.match(SRC, /message/, 'cloud sync should handle tab messages');
console.log('✓ multi-tab sync coordination contract is present');
