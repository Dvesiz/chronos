const assert = require('node:assert/strict');
const fs = require('node:fs');

const activity = fs.readFileSync('app/src/main/java/com/dvesiz/chronos/MainActivity.java', 'utf8');
const server = fs.readFileSync('backend/src/index.js', 'utf8');

assert.match(activity, /shouldInterceptRequest/, '本地页面应通过应用内资源拦截器提供');
assert.match(activity, /https:\/\/chronos\.local\//, '本地页面应使用固定 HTTPS 虚拟来源');
assert.match(activity, /setAllowUniversalAccessFromFileURLs\(false\)/, '必须关闭 file URL 的跨源访问');
assert.match(activity, /setAllowFileAccess\(false\)/, '必须关闭 WebView 任意文件访问');
assert.match(server, /https:\/\/chronos\.local/, 'Worker CORS 必须只放行固定内部来源');
console.log('✓ Android WebView：HTTPS 虚拟资源与 file URL 隔离');
