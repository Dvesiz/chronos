// Today plan regression: legacy/template sync must not append duplicate template tasks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const SRC = fs.readFileSync('app/src/main/assets/www/app.js', 'utf8');
const key = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const today = key(new Date());
const doc = { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}, createElement: () => ({ style: { setProperty() {} }, appendChild() {}, classList: { add() {}, remove() {}, toggle() {} } }) };
function ctx(seed) {
  const store = { 'chronos.state.v1': JSON.stringify(seed) };
  const c = { console, Date, Math, JSON, Number, String, Array, Object, Promise, setTimeout, clearTimeout,
    navigator: { vibrate() {}, share() { return Promise.resolve(); }, clipboard: { writeText() { return Promise.resolve(); } } },
    confirm: () => true, alert() {}, document: doc,
    localStorage: { getItem: k => store[k] || null, setItem: (k,v) => { store[k]=String(v); }, removeItem: k => delete store[k] },
    window: {}, performance: { now: () => Date.now() } };
  vm.createContext(c); vm.runInContext(SRC, c);
  ['renderHome','renderFocus','refreshStats','syncGuard','renderImmerse','closeImmerse','save','toast','haptic','checkMilestones'].forEach(n => { c[n] = () => {}; });
  return c;
}
const template = [
  { id: 'math', title: '数学真题', subject: '学习', start: 510, end: 690, note: '当前模板' },
  { id: 'english', title: '英语作文', subject: '学习', start: 780, end: 840, note: '当前模板' }
];
const duplicateTasks = [
  { id: `${today}:math-old`, templateId: 'math', title: '数学真题', start: 510, end: 690, status: 'done', modified: false },
  { id: `${today}:math-new`, templateId: 'math', title: '数学真题', start: 540, end: 720, status: 'todo', modified: false },
  { id: `${today}:english`, templateId: 'english', title: '英语作文', start: 780, end: 840, status: 'todo', modified: false },
  { id: `${today}:custom`, title: '临时新增任务', start: 900, end: 960, status: 'todo', modified: true }
];
const c = ctx({ template, days: { [today]: { tasks: duplicateTasks } }, pomo: { sessions: {} } });
const state = vm.runInContext('state', c);
assert.equal(typeof c.dedupeTodayTemplateTasks, 'function', '需要暴露今日模板任务去重函数');
c.dedupeTodayTemplateTasks(today);
const tasks = state.days[today].tasks;
assert.equal(tasks.filter(t => t.templateId === 'math').length, 1, '同一模板任务今日只能保留一份');
assert.equal(tasks.find(t => t.templateId === 'math').status, 'done', '重复时保留已有进度/完成状态的任务');
assert.equal(tasks.filter(t => t.templateId === 'english').length, 1);
assert.ok(tasks.some(t => t.title === '临时新增任务'), '用户临时新增任务不能被清理');
console.log('✓ 今日安排：历史模板重复任务去重，保留进度并保留自定义任务');

// 云端快照下发也必须走同一迁移，否则旧任务会被同步重新写回
const cloud = ctx({ template, days: {}, pomo: { sessions: {} } });
cloud.applyCloudState({
  template,
  days: { [today]: { tasks: duplicateTasks } },
  pomo: { sessions: {} }
}, true);
const cloudTasks = vm.runInContext('state.days["' + today + '"] .tasks', cloud);
assert.equal(cloudTasks.filter(t => t.templateId === 'math').length, 1,
  '云端快照应用后不能再次保留重复模板任务');
console.log('✓ 云端快照：应用同步数据时也执行今日模板去重');
