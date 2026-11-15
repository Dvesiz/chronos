// 网页端展示契约：版本号不能停留在过期兜底值，备份原因不能泄漏内部枚举。
const assert = require('node:assert/strict');
const fs = require('node:fs');

const INDEX = fs.readFileSync('app/src/main/assets/www/index.html', 'utf8');
const APP = fs.readFileSync('app/src/main/assets/www/app.js', 'utf8');
const CSS = fs.readFileSync('app/src/main/assets/www/styles.css', 'utf8');

assert.doesNotMatch(INDEX, /Version 2\.7\.1(?:\D|$)/, '网页版本兜底值不能继续显示 2.7.1');
assert.match(APP, /const v = \(n && n\.appVersion \? n\.appVersion\(\) : ''\) \|\| window\.CHRONOS_APP_VERSION/, '版本号必须读取统一配置');
assert.match(APP, /backupReasonLabel/, '备份原因必须经过用户可读文案映射');
assert.doesNotMatch(APP, /esc\(item\.reason \|\| '同步快照'\)/, '备份列表不得直接渲染内部 reason');
assert.match(CSS, /\.backup-list\s*\{/ , '备份列表需要独立布局');
assert.match(CSS, /\.backup-item\s*\{/, '备份项需要稳定的网格布局');
assert.match(INDEX, /app\.js\?v=[a-f0-9]+/, '网页脚本需要提交版本缓存键');
assert.match(INDEX, /styles\.css\?v=[a-f0-9]+/, '网页样式需要提交版本缓存键');
console.log('✓ 网页版本号与同步备份文案契约通过');
