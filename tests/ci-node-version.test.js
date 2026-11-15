const assert = require('node:assert/strict');
const fs = require('node:fs');

const packageJson = JSON.parse(fs.readFileSync('backend/package.json', 'utf8'));
const pages = fs.readFileSync('.github/workflows/pages.yml', 'utf8');
const release = fs.readFileSync('.github/workflows/release.yml', 'utf8');

assert.match(packageJson.scripts.test, /--experimental-test-isolation=none/,
  '后端测试必须使用 Node 22 可用的 experimental test isolation 参数');
assert.match(packageJson.scripts['test:frontend'], /--experimental-test-isolation=none/,
  '前端 cloud-sync 测试必须使用 Node 22 可用的 isolation 参数');
for (const workflow of [pages, release]) {
  assert.match(workflow, /actions\/setup-node@v\d+/, 'CI 必须显式固定 Node 主版本');
  assert.match(workflow, /node-version:\s*[\'\"]22[\'\"]/, 'CI 必须使用 Node 22');
}
console.log('✓ CI：Node 版本与测试隔离参数明确且兼容');
