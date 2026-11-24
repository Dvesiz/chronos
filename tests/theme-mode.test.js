const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const src = fs.readFileSync('app/src/main/assets/www/app.js', 'utf8');
const html = fs.readFileSync('app/src/main/assets/www/index.html', 'utf8');
assert.doesNotMatch(html, /<h1\b/i, '页面顶部不应保留主标题');
assert.match(html, /id="setTheme"[\s\S]*value="system"[\s\S]*value="light"[\s\S]*value="dark"/,
  '设置页应提供系统、浅色和深色模式');

const meta = { value: '', setAttribute(name, value) { if (name === 'content') this.value = value; } };
const root = { dataset: {} };
const body = { classList: { toggle() {} } };
const listeners = [];
const media = {
  matches: false,
  addEventListener(type, listener) { if (type === 'change') listeners.push(listener); }
};
const nativeThemes = [];
const themeControl = { value: '' };
const document = {
  body,
  documentElement: root,
  querySelector(selector) {
    if (selector === 'meta[name="theme-color"]') return meta;
    if (selector === '#setTheme') return themeControl;
    return null;
  },
  querySelectorAll() { return []; },
  addEventListener() {},
  createElement() { return { style: { setProperty() {} }, appendChild() {}, classList: { add() {}, remove() {}, toggle() {} } }; }
};
const ctx = {
  console, Date, Math, JSON, Number, String, Array, Object, Promise, setTimeout, clearTimeout,
  document,
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  window: {
    matchMedia() { return media; },
    Native: { setTheme(value) { nativeThemes.push(value); } }
  },
  navigator: { vibrate() {} },
  performance: { now: () => Date.now() }
};
vm.createContext(ctx);
vm.runInContext(src, ctx);

assert.equal(ctx.normalizeState({}).theme, 'system', '缺少主题设置时应默认跟随系统');
assert.equal(ctx.normalizeState({ theme: 'light' }).theme, 'light', '应保留已有浅色选择');
assert.equal(ctx.normalizeState({ theme: 'dark' }).theme, 'dark', '应保留已有深色选择');
assert.equal(ctx.normalizeState({ theme: 'invalid' }).theme, 'system', '无效主题应回退到系统模式');

ctx.bindSystemTheme();
ctx.bindSystemTheme();
ctx.applyTheme();
assert.equal(listeners.length, 1, '系统主题监听器只应绑定一次');
assert.equal(root.dataset.theme, 'light');
assert.equal(meta.value, '#f2f2f4');
assert.equal(nativeThemes.at(-1), 'light');

media.matches = true;
listeners[0]();
assert.equal(root.dataset.theme, 'dark', '系统切换深色时页面应自动变暗');
assert.equal(meta.value, '#0f0f12', '系统切换时浏览器主题色应同步');
assert.equal(nativeThemes.at(-1), 'dark', '系统切换时 Android 状态栏主题应同步');
assert.equal(vm.runInContext('state.theme', ctx), 'system', '系统解析结果不应覆盖已保存的跟随模式');

vm.runInContext("state.theme = 'light'", ctx);
listeners[0]();
assert.equal(root.dataset.theme, 'dark', '手动模式下系统偏好变化不应覆盖当前主题');
ctx.applyTheme();
assert.equal(root.dataset.theme, 'light', '手动浅色模式应生效');
vm.runInContext("state.theme = 'dark'", ctx);
ctx.applyTheme();
assert.equal(root.dataset.theme, 'dark', '手动深色模式应生效');

ctx.todayKey = () => '2026-11-15';
ctx.dedupeTodayTemplateTasks = () => {};
ctx.save = () => {};
ctx.renderAccountUI = () => {};
ctx.renderHome = () => {};
ctx.refreshStats = () => {};
ctx.renderGoalSettings = () => {};
ctx.applyCloudState({ theme: 'system', days: {}, template: [] }, true);
assert.equal(themeControl.value, 'system', '云端下发的主题模式应更新设置选择器');
assert.equal(root.dataset.theme, 'dark', '云端下发系统模式应按本机当前深色偏好显示');
assert.equal(vm.runInContext('state.theme', ctx), 'system', '云端系统模式应作为主题偏好保存');

ctx.window.ChronosCloud = {
  hasSession: () => true,
  sessionUser: () => ({ email: 'android@example.com', nickname: 'Android' }),
  init: hooks => { ctx.cloudHooks = hooks; },
  queueState: next => { ctx.cloudQueued = next; }
};
ctx.initCloudSync();
ctx.applyCloudState({ theme: 'dark', days: {}, template: [], user: null }, true);
assert.equal(vm.runInContext('state.user?.email', ctx), 'android@example.com', 'a cloud document cannot log the local account out');
assert.equal(Object.hasOwn(ctx.cloudHooks.get(), 'user'), false, 'account identity must not seed cloud business data');
ctx.queueCloudSync();
assert.equal(Object.hasOwn(ctx.cloudQueued, 'user'), false, 'account identity must not be queued');

console.log('✓ 主题模式：系统跟随、即时响应、手动覆盖与原生状态栏联动');
