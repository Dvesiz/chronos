const assert = require('node:assert/strict');
const fs = require('node:fs');
const SRC = fs.readFileSync('app/src/main/assets/www/cloud-sync.js', 'utf8');
assert.match(SRC, /navigator\.locks|locks\.request/, 'cloud sync should use Web Locks when available');
assert.match(SRC, /chronos-sync-write/, 'writes should share a stable lock name');
assert.match(SRC, /BroadcastChannel/, 'broadcast notification remains available');
console.log('✓ Web Locks：跨标签页写入互斥契约');
