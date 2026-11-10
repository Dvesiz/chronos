// Regression: adding time slots inside the daily template must stay in the
// template sheet, so the user can add several slots in a row.
// Bug: openEditor() called closeSheet() after save/cancel, which dropped the
// user back to the home screen and forced a new "编辑计划 → 编辑每日模板" trip.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const SRC = fs.readFileSync('app/src/main/assets/www/app.js', 'utf8');

function makeEl(id) {
  return {
    id, innerHTML: '', dataset: {}, style: {}, value: '', checked: true, textContent: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, appendChild() {}, remove() {},
    addEventListener(type, fn) { (this.handlers = this.handlers || {})[type] = fn; },
    querySelector: () => makeEl('child'),
    querySelectorAll: () => [],
    closest: () => null
  };
}

const elements = new Map();
const getEl = sel => { if (!elements.has(sel)) elements.set(sel, makeEl(sel)); return elements.get(sel); };

const document = {
  querySelector: getEl,
  querySelectorAll: () => [],
  addEventListener() {},
  createElement: () => makeEl('created'),
  body: { contains: () => true, classList: { add() {}, remove() {} } },
  hidden: false
};

const store = { 'chronos.state.v1': JSON.stringify({ template: [], days: {}, pomo: { sessions: {} } }) };
const ctx = {
  console, Date, Math, JSON, Number, String, Array, Object, Promise,
  setTimeout: () => 1, clearTimeout() {},
  navigator: { vibrate() {}, share: () => Promise.resolve(), clipboard: { writeText: () => Promise.resolve() } },
  confirm: () => true, alert() {},
  document,
  localStorage: {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; }
  },
  window: {},
  performance: { now: () => Date.now() }
};
vm.createContext(ctx);
vm.runInContext(SRC, ctx);

let mounted = null;
let sheetState = 'open';
ctx.openSheet = (html, afterMount) => { mounted = afterMount; sheetState = 'open'; };
ctx.closeSheet = () => { sheetState = 'closed'; };
ctx.openTemplateSheet = () => { sheetState = 'template'; };
ctx.openPlanSheet = () => { sheetState = 'plan'; };
ctx.renderHome = () => {};
ctx.refreshStats = () => {};
ctx.toast = () => {};
ctx.save = () => {};
ctx.haptic = () => {};

const state = () => vm.runInContext('state', ctx);
const panelStub = {
  querySelector: sel => {
    const map = {
      '#fTitle': { value: '读书' }, '#fSubject': { value: '阅读' },
      '#fStart': { value: '10:00' }, '#fEnd': { value: '11:00' },
      '#fNote': { value: '' }, '#fRemind': { checked: true }, '#fFlex': { checked: true }
    };
    return map[sel] || getEl(sel);
  },
  querySelectorAll: () => []
};

// --- template mode: save and cancel both go back to the template list -------
state().template = [{ id: 't1', title: '读书', subject: '阅读', start: 600, end: 660, note: '', reminder: true, flex: true }];
ctx.openEditor(state().template[0], 'template');
mounted(panelStub);
getEl('#btnSaveEdit').handlers.click();
assert.equal(sheetState, 'template', '保存模板时段后应回到模板列表');

ctx.openEditor(state().template[0], 'template');
mounted(panelStub);
getEl('#btnCancelEdit').handlers.click();
assert.equal(sheetState, 'template', '取消编辑模板时段后应回到模板列表');

// --- day-plan mode keeps the old behaviour (close the sheet) ---------------
const dayKey = vm.runInContext('todayKey()', ctx);
state().days[dayKey] = { tasks: [{ id: 'a', title: 'a', subject: '学习', start: 600, end: 660, status: 'todo', focusAcc: 0, pomoAcc: 0, focusStart: null }] };
sheetState = 'open';
ctx.openEditor(state().days[dayKey].tasks[0], 'day');
mounted(panelStub);
getEl('#btnSaveEdit').handlers.click();
assert.equal(sheetState, 'closed', '编辑今日计划仍应关闭弹层（保持原行为）');

console.log('✓ 每日模板连续添加时段；今日计划编辑行为不变');
