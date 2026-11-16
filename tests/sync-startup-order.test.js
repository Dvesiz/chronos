const assert = require('node:assert/strict');
const fs = require('node:fs');

const app = fs.readFileSync('app/src/main/assets/www/app.js', 'utf8');
const bootStart = app.indexOf('async function boot() {');
const bootEnd = app.indexOf('\n}\n', bootStart);
assert.ok(bootStart >= 0 && bootEnd > bootStart, '需要找到应用启动流程');
const boot = app.slice(bootStart, bootEnd);
const position = text => boot.indexOf(text);

assert.ok(position('state = await loadStateAsync();') >= 0, '应先读取本地状态');
assert.ok(position('settleStaleTimers();') < position('initCloudSync();'),
  '应先结算本地过期计时，再开始云端对账');
assert.ok(position('ensureToday();') < position('initCloudSync();'),
  '应先初始化本地当天计划，再开始云端对账，避免旧模板进入上传队列');
assert.ok(position('tickPomo();') < position('initCloudSync();'),
  '应先结算本地已到期番茄钟，再开始云端对账');

console.log('✓ 启动同步顺序：先完成本地初始化，后连接云端');
