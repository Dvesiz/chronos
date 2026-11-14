const assert = require('node:assert/strict');
const fs = require('node:fs');
const SRC = fs.readFileSync('app/src/main/assets/www/cloud-sync.js', 'utf8');
assert.match(SRC, /indexedDB/, 'sync adapter should expose IndexedDB path');
assert.match(SRC, /outbox|queue/i, 'IndexedDB path should store outbox records');
assert.match(SRC, /localStorage/, 'localStorage fallback must remain available');
console.log('✓ IndexedDB outbox compatibility contract is present');
