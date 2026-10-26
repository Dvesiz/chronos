/* =========================================================
   时序 · Chronos — app logic
   ========================================================= */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const STORE = 'chronos.state.v1';
const N = () => (window.Native ? window.Native : null);

/* ---------------- 工具 ---------------- */
const pad = n => String(n).padStart(2, '0');
const dateKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60; };
const hm = m => { const v = Math.max(0, Math.round(m)); return `${pad(Math.floor(v / 60))}:${pad(v % 60)}`; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const DOW = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const DOW_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function humanSec(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h && m) return `${h} 小时 ${m} 分`;
  if (h) return `${h} 小时`;
  return `${m} 分钟`;
}
function clockStr(sec) {
  sec = Math.max(0, Math.floor(sec));
  return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`;
}
const hours = sec => (sec / 3600);
function hText(sec) {
  const h = sec / 3600;
  if (h <= 0) return '0h';
  return (h >= 10 ? h.toFixed(0) : h.toFixed(1)) + 'h';
}

const SUBJECTS = {
  '工作': '#3478f6',
  '学习': '#af52de',
  '阅读': '#34c759',
  '运动': '#ff9f0a',
  '休息': '#8e8e93',
  '其他': '#8e8e93'
};
const subjectColor = s => SUBJECTS[s] || '#8e8e93';

/** 柱状图配色：让每根柱子有各自的色彩 */
const BAR_GRADS = [
  ['#ffb26b', '#ff7a1f'], ['#7ec8ff', '#3478f6'], ['#b39bff', '#7b52dd'],
  ['#6ee7a8', '#1fae6e'], ['#ffd166', '#f59e0b'], ['#ff9ec4', '#f43f75'],
  ['#7de0ea', '#1a9ec0'], ['#a8d94a', '#65a30d']
];
const barGrad = i => BAR_GRADS[((i % BAR_GRADS.length) + BAR_GRADS.length) % BAR_GRADS.length];

const STATUS_TEXT = { todo: '待开始', doing: '进行中', done: '已完成', skipped: '已跳过' };

/* ---------------- 默认模板：仅一个示例时段，供新用户参考 ---------------- */
function defaultTemplate() {
  return [
    { id: 't1', title: '示例 · 深度工作', subject: '工作', start: 540, end: 600, note: '这是一个示例时段 · 点「编辑计划」改成你自己的安排', reminder: true, advance: 5, flex: true, priority: 2 }
  ];
}

/* ---------------- 状态 ---------------- */
let state = loadState();

function loadState() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (e) { s = null; }
  if (!s || !Array.isArray(s.template) || !s.template.length) {
    s = {
      theme: 'light',
      motion: true,
      remind: true,
      advance: 5,
      template: defaultTemplate(),
      days: {},
      demo: false
    };
  }
  s.days = s.days || {};
  if (typeof s.motion !== 'boolean') s.motion = true;
  if (typeof s.remind !== 'boolean') s.remind = true;
  if (!s.advance && s.advance !== 0) s.advance = 5;
  if (!s.user || typeof s.user !== 'object' || !s.user.email) s.user = null;

  // 番茄钟
  s.pomo = s.pomo || {};
  const p = s.pomo;
  if (typeof p.preset !== 'number') p.preset = 25;
  if (typeof p.auto !== 'boolean') p.auto = false;
  if (typeof p.sound !== 'boolean') p.sound = true;
  if (!p.sessions || typeof p.sessions !== 'object') p.sessions = {};
  if (p.phase !== 'break') p.phase = 'focus';
  if (typeof p.remain !== 'number' || p.remain <= 0) p.remain = p.preset * 60;
  if (typeof p.running !== 'boolean') p.running = false;
  if (!p.endAt) p.endAt = null;
  if (typeof p.round !== 'number') p.round = 0;
  if (typeof p.guard !== 'boolean') p.guard = false;
  return s;
}

let saveTimer = null;
function save(immediate) {
  const doSave = () => {
    const keys = Object.keys(state.days).sort();
    while (keys.length > 120) delete state.days[keys.shift()];
    // 番茄记录同样按 120 天裁剪，否则 JSON 会无限膨胀（每次保存都要全量序列化 + 重建闹钟）
    const cutoff = keys.length ? keys[0] : dateKey(addDays(new Date(), -120));
    const sessions = (state.pomo && state.pomo.sessions) || {};
    Object.keys(sessions).forEach(k => { if (k < cutoff) delete sessions[k]; });
    try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) {}
    const n = N();
    if (n && n.saveState) {
      try { n.saveState(JSON.stringify(state)); } catch (e) {}
    }
    syncNative();
  };
  if (immediate) { clearTimeout(saveTimer); doSave(); return; }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 180);
}

/* ---------------- 当日任务 ---------------- */
function cloneTask(t, dateK) {
  return {
    id: t.id,
    title: t.title,
    subject: t.subject,
    start: t.start,
    end: t.end,
    note: t.note || '',
    reminder: t.reminder !== false,
    advance: typeof t.advance === 'number' ? t.advance : 5,
    flex: t.flex !== false,
    status: 'todo',
    actual: 0,
    focusAcc: 0,
    focusStart: null,
    pomoAcc: 0,
    pomoCount: 0,
    modified: false,
    parent: null,
    date: dateK
  };
}

function ensureToday() {
  const k = dateKey(new Date());
  if (!state.days[k]) {
    state.days[k] = {
      tasks: state.template.map(t => cloneTask(t, k)),
      createdAt: Date.now()
    };
    save();
  }
  return state.days[k];
}

const todayRec = () => state.days[dateKey(new Date())];
const todayKey = () => dateKey(new Date());

function taskSeconds(t) {
  const base = t.focusStart ? t.focusAcc + (Date.now() - t.focusStart) / 1000 : (t.focusAcc || 0);
  return base + (t.pomoAcc || 0);
}
function taskEnd(t) { return t.end; }
function taskDur(t) { return Math.max(0, taskEnd(t) - t.start); }

function currentInfo(rec) {
  const now = nowMin();
  const tasks = rec.tasks || [];
  const doing = tasks.find(t => t.status === 'doing' && t.focusStart);
  if (doing) return { mode: 'doing', task: doing };
  /* 时间窗内：优先未完成项；若当前时段已标记完成但还有补时需求（曾开始过计时），仍选中它 */
  const active = tasks
    .filter(t => now >= t.start && now < taskEnd(t) && t.status !== 'skipped')
    .sort((a, b) => (a.status === 'done' ? 1 : 0) - (b.status === 'done' ? 1 : 0) || a.start - b.start)[0];
  if (active && active.status !== 'done') return { mode: 'active', task: active };
  if (active && (active.focusAcc || active.pomoAcc)) return { mode: 'active', task: active };
  const next = tasks
    .filter(t => t.status !== 'done' && t.status !== 'skipped' && t.start > now)
    .sort((a, b) => a.start - b.start)[0];
  if (next) return { mode: 'next', task: next, inMinutes: Math.round(next.start - now) };
  const later = tasks.filter(t => t.status === 'todo' && t.start > now)[0];
  return { mode: 'idle', task: null, later };
}

/* ---------------- 原生同步 ---------------- */
let syncTimer = null;
function syncNative() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    const n = N();
    if (!n || !n.schedule) return;
    const days = [];
    const today = new Date();
    for (let i = 0; i < 7; i++) {
      const d = addDays(today, i);
      const k = dateKey(d);
      const rec = state.days[k];
      const tasks = rec ? rec.tasks : state.template.map(t => cloneTask(t, k));
      days.push({
        date: k,
        tasks: tasks.map(t => ({
          id: t.id,
          title: t.title,
          subject: t.subject,
          start: Math.round(t.start),
          end: Math.round(taskEnd(t)),
          status: t.status || 'todo',
          reminder: t.reminder !== false && state.remind !== false,
          advance: state.advance
        }))
      });
    }
    try { n.schedule(JSON.stringify({ days: days, settings: { remind: state.remind, advance: state.advance } })); } catch (e) {}
  }, 500);
}

function consumeNative() {
  const n = N();
  if (!n) return;
  let pending = null;
  try { pending = n.consumePending ? n.consumePending() : null; } catch (e) {}
  if (pending) {
    try {
      const p = JSON.parse(pending);
      if (p.taskId) {
        // 通知里带了 date：23:59 的提醒、或"延后"跨到次日，也能定位到正确的任务
        const rec = (p.date && state.days[p.date]) || todayRec();
        const t = rec && rec.tasks.find(x => x.id === p.taskId);
        if (t) {
          if (p.action === 'delay') delayTask(t, 10, true);
          else if (p.action === 'start') startTask(t);
          setTimeout(() => { switchTab(0); openTaskSheet(t); }, 260);
        } else {
          toast('这条提醒对应的任务已不在计划里');
        }
      }
    } catch (e) {}
  }
  let overlay = null;
  try { overlay = n.consumeOverlay ? n.consumeOverlay() : null; } catch (e) {}
  if (overlay) {
    try {
      const o = JSON.parse(overlay);
      Object.keys(o).forEach(k => {
        const rec = state.days[k];
        if (!rec) return;
        Object.keys(o[k]).forEach(id => {
          const t = rec.tasks.find(x => x.id === id);
          if (t) {
            if (o[k][id] === 'done') {
              // 只标记完成，不伪造时长：没计时就是 0，统计才可信
              t.status = 'done';
              t.focusStart = null;
            } else if (o[k][id] === 'skipped') t.status = 'skipped';
          }
        });
      });
      save(true);
      renderHome();
      toast('已同步通知上的操作');
    } catch (e) {}
  }
  // 用户在锁定面板确认放弃本轮
  let gaveUp = false;
  try { gaveUp = n.consumeGuardGiveUp ? !!n.consumeGuardGiveUp() : false; } catch (e) {}
  if (gaveUp) {
    state.pomo.broken = (state.pomo.broken || 0) + 1;
    state.pomo.guard = false;
    // 只有用户自己确认放弃才算结束；这里不额外改动计时，避免静默打断
    if (state.pomo.running) {
      state.pomo.remain = pomoRemain();
      state.pomo.endAt = null;
      state.pomo.running = false;
    }
    save(true);
    syncGuard();
    renderFocus();
    renderPomoMini();
    toast('已退出极度沉浸 · 本轮专注暂停');
  }
}

/* ---------------- 时间格式 ---------------- */
function greetingFor(h) {
  if (h < 5) return '夜深了，先好好休息。';
  if (h < 9) return '今天，从第一段专注开始。';
  if (h < 12) return '上午的专注，最值钱。';
  if (h < 14) return '午休之后，继续推进。';
  if (h < 17) return '现在，啃下最硬的那块。';
  if (h < 19) return '黄昏时分，喘口气。';
  if (h < 22) return '晚上的时间，也能拉开差距。';
  return '今天，保持自己的节奏。';
}

/* ---------------- 首页渲染 ---------------- */
function renderHome() {
  const rec = ensureToday();
  const d = new Date();
  $('#dow').textContent = DOW[d.getDay()];
  $('#dateText').textContent = `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  $('#greeting').textContent = greetingFor(d.getHours());

  const tasks = rec.tasks || [];
  const total = tasks.length;
  const done = tasks.filter(t => t.status === 'done').length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  $('#doneCount').textContent = done;
  $('.ring-center span').textContent = `/ ${total}`;
  $('#pct').textContent = pct;

  const planned = tasks.reduce((a, t) => a + taskDur(t) * 60, 0);
  const actual = tasks.reduce((a, t) => a + taskSeconds(t), 0);
  $('#planText').textContent = hText(planned);
  $('#actualText').textContent = hText(actual);

  const circumference = 2 * Math.PI * 51;
  const ring = $('#ringFg');
  ring.style.strokeDasharray = circumference;
  requestAnimationFrame(() => {
    ring.style.strokeDashoffset = circumference * (1 - pct / 100);
  });

  renderNow();
  renderTimeline();
  renderPomoMini();
  updateClocks();
}

function renderNow() {
  const rec = todayRec();
  if (!rec) return;
  const info = currentInfo(rec);
  const el = $('#nowCard');
  const timeStr = new Date().toTimeString().slice(0, 5);

  if (!info.task) {
    el.classList.remove('is-lit');
    el.innerHTML = `
      <div class="sheen"></div>
      <div class="now-top">
        <div class="state-pill idle"><span class="dot"></span>IDLE · 空闲</div>
        <div class="now-subject">${timeStr}</div>
      </div>
      <div class="now-empty">
        <h3>当前没有计划安排</h3>
        <p>${info.inMinutes != null ? `距离下一项任务还有 ${info.inMinutes} 分钟，先让自己松一口气。` : '今天的安排已经走完了，剩下的时间留给休息。'}</p>
      </div>
      <div class="now-actions">
        <button class="btn btn-ghost" style="flex:1" data-hero="plan">查看今日计划</button>
      </div>`;
    bindHero(el);
    el.dataset.sig = 'idle';
    return;
  }

  const t = info.task;
  const dur = taskDur(t);
  const elapsed = clamp(nowMin() - t.start, 0, dur);
  const remaining = Math.max(0, dur - elapsed);
  const pct = dur ? clamp(elapsed / dur * 100, 0, 100) : 0;
  const sec = taskSeconds(t);

  let pillClass, pillText, timerMain = '', timerSub = '';
  if (info.mode === 'doing' || (info.mode === 'active' && t.status === 'doing')) {
    pillClass = 'accent';
    pillText = 'NOW · 正在进行';
    timerMain = clockStr(sec);
    timerSub = '已专注';
  } else if (info.mode === 'active') {
    pillClass = 'accent';
    pillText = 'NOW · 正在进行';
    timerMain = humanSec(remaining * 60);
    timerSub = '距离结束';
  } else {
    pillClass = 'idle';
    pillText = 'UP NEXT · 即将开始';
    timerMain = info.inMinutes >= 60 ? humanSec(info.inMinutes * 60) : info.inMinutes + ' 分钟';
    timerSub = '距离开始';
  }

  el.innerHTML = `
    <div class="sheen"></div>
    <div class="now-top">
      <div class="state-pill ${pillClass}"><span class="dot"></span>${pillText}</div>
      <div class="now-subject">${t.subject || '学习'}</div>
    </div>
    <h2 class="now-title">${esc(t.title)}</h2>
    <div class="now-meta">
      <span>${hm(t.start)} — ${hm(taskEnd(t))}</span>
      <span class="sep"></span>
      <span>${info.mode === 'active' || info.mode === 'doing' ? '已进行 ' + Math.round(elapsed) + ' 分钟' : '共 ' + Math.round(dur) + ' 分钟'}</span>
    </div>
    <div class="now-timer"><b id="heroTimer" class="${timerMain.length > 6 ? 'is-long' : ''}">${timerMain}</b><span>${timerSub}</span></div>
    ${info.mode === 'active' || info.mode === 'doing' ? `<div class="now-progress"><i style="width:${pct}%"></i></div>` : ''}
    <div class="now-actions">
      <button class="btn btn-primary" data-hero="start">
        ${t.status === 'doing' ? '暂停专注' : '开始专注'}
      </button>
      <button class="btn btn-ghost hero-guard${state.pomo.guard ? ' is-on' : ''}" data-hero="guard"
              aria-pressed="${state.pomo.guard ? 'true' : 'false'}">
        <span class="gdot"></span>${state.pomo.guard ? '沉浸中' : '沉浸'}
      </button>
      <button class="btn btn-ghost" data-hero="detail">查看任务</button>
    </div>`;
  el.classList.toggle('is-lit', info.mode === 'active' || info.mode === 'doing');
  el.dataset.sig = info.mode + ':' + t.id + ':' + t.status;
  bindHero(el, t);
}

function bindHero(el, task) {
  const n = N();
  el.querySelectorAll('[data-hero]').forEach(btn => {
    btn.addEventListener('click', () => {
      haptic('light');
      const act = btn.dataset.hero;
      if (act === 'start' && task) {
        if (task.status === 'doing') pauseTask(task); else startTask(task);
        renderHome();
        if (sheetOpen && sheetTaskId === task.id) openTaskSheet(task, true);
      } else if (act === 'guard') {
        setGuardEnabled(!state.pomo.guard);
        renderNow();
      } else if (act === 'detail' && task) {
        openTaskSheet(task);
      } else if (act === 'plan') {
        openPlanSheet();
      }
    });
  });
}

function renderTimeline() {
  const rec = todayRec();
  const wrap = $('#timeline');
  if (!rec) return;
  const info = currentInfo(rec);
  const tasks = (rec.tasks || []).slice().sort((a, b) => a.start - b.start);

  wrap.innerHTML = tasks.map((t, i) => {
    const isNow = info.task && info.task.id === t.id && (info.mode === 'active' || info.mode === 'doing');
    const sec = taskSeconds(t);
    const p = taskDur(t) ? clamp(sec / 60 / taskDur(t) * 100, 0, 100) : 0;
    const statusIcon = t.status === 'done'
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l5 5 10-11"/></svg>'
      : '';
    return `
      <div class="tl-item ${t.status === 'done' ? 'is-done' : ''} ${t.status === 'skipped' ? 'is-skipped' : ''} ${isNow ? 'is-now' : ''}"
           data-id="${t.id}" style="animation-delay:${Math.min(i * 0.045, .3)}s">
        <div class="tl-time"><b>${hm(t.start)}</b><i>${hm(taskEnd(t))}</i></div>
        <div class="tl-card">
          <div class="tl-top">
            <h3 class="tl-title">${esc(t.title)}</h3>
            <span class="tl-status">${statusIcon}</span>
          </div>
          <p class="tl-note">${esc(t.note || t.subject || '')}</p>
          ${(isNow && sec > 0) ? `<div class="tl-bar"><i style="width:${p}%"></i></div>` : ''}
        </div>
      </div>`;
  }).join('');

  wrap.querySelectorAll('.tl-item').forEach(row => {
    row.addEventListener('click', () => {
      const t = rec.tasks.find(x => x.id === row.dataset.id);
      if (t) { haptic('light'); openTaskSheet(t); }
    });
  });
}

function updateClocks() {
  const d = new Date();
  const s = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  ['#liveClock', '#clockFocus', '#clockStats', '#clockSettings'].forEach(sel => {
    const el = $(sel);
    if (el) el.textContent = s;
  });
}

/* ---------------- 任务操作 ---------------- */
function startTask(t) {
  if (t.focusStart) return;              // 已经在计时中
  if (t.status === 'done') {
    /* 完成后继续补时：保留已累计的专注时长，在其基础上继续计时 */
    t.status = 'doing';
    t.focusStart = Date.now();
    t.modified = true;
    save();
    syncGuard();
    toast('继续专注 · 已累计 ' + humanSec(taskSeconds(t)));
    return;
  }
  t.focusStart = Date.now();
  t.status = 'doing';
  t.modified = true;
  save();
  syncGuard();
  toast('专注开始 · 保持节奏');
}

function pauseTask(t) {
  if (t.focusStart) {
    t.focusAcc = (t.focusAcc || 0) + (Date.now() - t.focusStart) / 1000;
    t.focusStart = null;
  }
  if (t.status === 'doing') t.status = 'todo';
  save();
  syncGuard();
  toast('已暂停计时');
}

function completeTask(t) {
  if (t.focusStart) {
    t.focusAcc = (t.focusAcc || 0) + (Date.now() - t.focusStart) / 1000;
    t.focusStart = null;
  }
  t.status = 'done';
  t.actual = (t.focusAcc || 0) + (t.pomoAcc || 0);
  t.modified = true;
  save(true);
  syncGuard();
  if (navigator.vibrate) navigator.vibrate(18);
  haptic('success');
  toast(t.actual > 60 ? '已完成 · ' + humanSec(t.actual) : '已完成 · 这段没有计时');
}

function undoTask(t) {
  t.status = 'todo';
  t.modified = true;
  save(true);
  toast('已恢复为待开始');
}

function delayTask(t, minutes, silent) {
  const m = minutes || 10;
  const dur = taskDur(t);
  t.start = Math.min(t.start + m, 1439 - dur);
  t.end = t.start + dur;
  t.modified = true;
  save(true);
  syncGuard();
  if (!silent) toast(`已延后 ${m} 分钟 · ${hm(t.start)} 开始`);
}

function shortenTask(t, minutes) {
  const m = minutes || 15;
  t.end = Math.max(t.start + 15, taskEnd(t) - m);
  t.modified = true;
  save(true);
  syncGuard();
  toast(`已缩短 ${m} 分钟 · 保留后续安排`);
}

function skipTask(t) {
  t.status = t.status === 'skipped' ? 'todo' : 'skipped';
  t.modified = true;
  save(true);
  toast(t.status === 'skipped' ? '已跳过 · 不再提醒' : '已恢复任务');
}

function splitTask(t) {
  const rec = todayRec();
  if (!rec) return;
  const dur = taskDur(t);
  if (dur < 50) { toast('时间太短，暂时无法拆分'); return; }
  const firstEnd = Math.round(t.start + dur * 0.55);
  const restStart = Math.min(firstEnd + 10, taskEnd(t) - 15);
  const a = { ...t, id: t.id + 'a', title: t.title, end: firstEnd, modified: true, parent: t.id, status: t.status === 'done' ? 'done' : 'todo' };
  const b = { ...t, id: t.id + 'b', title: '复盘 · ' + t.title, start: restStart, note: '订正错题 · 归纳复盘', modified: true, parent: t.id, status: 'todo', actual: 0, focusAcc: 0, focusStart: null };
  const idx = rec.tasks.findIndex(x => x.id === t.id);
  rec.tasks.splice(idx, 1, a, b);
  save(true);
  toast('已拆分 · 中间留了 10 分钟休息');
  renderHome();
  openTaskSheet(a);
}

/* ---------------- 任务详情面板 ---------------- */
let sheetOpen = false;
let sheetTaskId = null;
let sheetBuild = null;

function openSheet(html, afterMount) {
  const layer = $('#sheetLayer');
  const panel = $('#sheetPanel');
  panel.innerHTML = `<div class="sheet-grabber" id="grabber"></div>` + html;
  layer.classList.add('open');
  layer.setAttribute('aria-hidden', 'false');
  sheetOpen = true;
  panel.scrollTop = 0;
  if (afterMount) afterMount(panel);
  bindSheetDrag(panel);
  const closeBtn = $('.sheet-close', panel);
  if (closeBtn) closeBtn.addEventListener('click', () => { haptic('light'); closeSheet(); });
}

function closeSheet() {
  const layer = $('#sheetLayer');
  layer.classList.remove('open');
  layer.setAttribute('aria-hidden', 'true');
  sheetOpen = false;
  sheetTaskId = null;
  sheetBuild = null;
  renderHome();
}

let dragState = null;
function bindSheetDrag(panel) {
  const grab = panel.querySelector('.sheet-grabber');
  if (!grab) return;
  let startY = 0, dy = 0, active = false;
  const down = e => {
    if (panel.scrollTop > 0) return;
    active = true; startY = e.touches ? e.touches[0].clientY : e.clientY; dy = 0;
    panel.classList.add('dragging');
    if (!e.touches) {
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    }
  };
  const move = e => {
    if (!active) return;
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    dy = Math.max(0, y - startY);
    if (dy > 0) {
      panel.style.transform = `translateY(${dy}px)`;
      if (e.cancelable) e.preventDefault();
    }
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    if (!active) return;
    active = false;
    panel.classList.remove('dragging');
    panel.style.transform = '';
    if (dy > 90) closeSheet();
  };
  grab.addEventListener('touchstart', down, { passive: true });
  grab.addEventListener('touchmove', move, { passive: false });
  grab.addEventListener('touchend', up);
  grab.addEventListener('mousedown', down);
}

function openTaskSheet(t, keep) {
  if (!t) return;
  sheetTaskId = t.id;
  const rec = todayRec();
  const live = rec.tasks.find(x => x.id === t.id) || t;
  const sec = taskSeconds(live);
  const plannedMin = Math.round(taskDur(live));
  const status = STATUS_TEXT[live.status] || '待开始';
  const isDone = live.status === 'done';
  const isSkip = live.status === 'skipped';
  const isFocus = !!live.focusStart;

  const html = `
    <div class="sheet-head">
      <div style="flex:1;min-width:0">
        <div class="sheet-eyebrow">TASK · ${esc(live.subject || '学习')}</div>
        <h2 class="sheet-title">${esc(live.title)}</h2>
        <div class="sheet-meta">${hm(live.start)} — ${hm(taskEnd(live))} · ${plannedMin} 分钟</div>
      </div>
      <button class="sheet-close" aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg></button>
    </div>
    ${live.note ? `<p class="sheet-note">${esc(live.note)}</p>` : ''}
    <div class="sheet-stats">
      <div class="sheet-stat"><q>计划</q><b>${plannedMin} 分钟</b></div>
      <div class="sheet-stat"><q>实际</q><b id="sheetActual">${Math.round(sec / 60)} 分钟</b></div>
      <div class="sheet-stat"><q>状态</q><b>${status}</b></div>
    </div>
    <div class="focus-panel">
      <div>
        <div class="focus-time" id="focusTime">${clockStr(sec)}</div>
        <div class="focus-label">${isFocus ? '专注中' : (sec > 0 ? '已累计专注' : (isDone ? '已标记完成 · 可继续补时' : '尚未开始计时'))}</div>
      </div>
      <div class="focus-btns">
        <button class="btn btn-ghost" data-act="${isFocus ? 'pause' : 'start'}" style="height:40px;padding:0 16px">
          ${isFocus ? '暂停' : (isDone ? '继续' : '开始')}
        </button>
      </div>
    </div>
    <div class="action-grid">
      <button class="action" data-act="delay">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 8v4l3 2"/><circle cx="12" cy="12" r="9"/></svg>
        延后 10 分钟
      </button>
      <button class="action" data-act="shorten">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 12h9M9 8l4 4-4 4"/><path d="M17 5v14"/></svg>
        缩短 15 分钟
      </button>
      <button class="action" data-act="split">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 3v6M12 15v6"/><circle cx="12" cy="12" r="3"/></svg>
        拆分任务
      </button>
      <button class="action ${isSkip ? 'ok' : 'warn'}" data-act="skip">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M5 6l14 12M19 6L5 18"/></svg>
        ${isSkip ? '恢复任务' : '跳过任务'}
      </button>
      <button class="action" data-act="edit">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 20h4l11-11-4-4L4 16z"/><path d="M13 5l4 4"/></svg>
        调整计划
      </button>
      <button class="action" data-act="template">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M8 9h8M8 13h5"/></svg>
        写入每日模板
      </button>
    </div>
    <div class="sheet-actions">
      <button class="btn btn-primary" data-act="${isDone ? 'undo' : 'done'}">
        ${isDone ? '撤销完成' : '完成任务'}
      </button>
    </div>
    <button class="btn btn-ghost btn-del" data-act="delete" style="width:100%;margin-top:10px">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" style="width:16px;height:16px"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 7l1 12a1.6 1.6 0 0 0 1.6 1.5h5.8a1.6 1.6 0 0 0 1.6-1.5l1-12"/></svg>
      删除这个时段 · 仅今日
    </button>`;

  openSheet(html, panel => {
    panel.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        haptic('light');
        if (act === 'start') { startTask(live); renderHome(); openTaskSheet(live, true); }
        else if (act === 'pause') { pauseTask(live); renderHome(); openTaskSheet(live, true); }
        else if (act === 'done') { completeTask(live); renderHome(); openTaskSheet(live, true); }
        else if (act === 'undo') { undoTask(live); renderHome(); openTaskSheet(live, true); }
        else if (act === 'delay') { delayTask(live, 10); renderHome(); openTaskSheet(live, true); }
        else if (act === 'shorten') { shortenTask(live, 15); renderHome(); openTaskSheet(live, true); }
        else if (act === 'skip') { skipTask(live); renderHome(); openTaskSheet(live, true); }
        else if (act === 'split') { closeSheet(); splitTask(live); }
        else if (act === 'edit') { openEditor(live, 'day'); }
        else if (act === 'template') { writeToTemplate(live); }
        else if (act === 'delete') { armDelete(btn, () => {
          const r = todayRec();
          if (r) r.tasks = r.tasks.filter(x => x.id !== live.id);
          save(true); closeSheet(); renderHome(); renderStats();
          toast('已从今日计划删除');
        }); }
      });
    });
  });
}

function writeToTemplate(t) {
  const tpl = state.template.find(x => x.id === t.id || x.title === t.title);
  if (tpl) {
    tpl.start = Math.round(t.start); tpl.end = Math.round(t.end);
    tpl.title = t.title; tpl.subject = t.subject; tpl.note = t.note;
    tpl.reminder = t.reminder;
  } else {
    state.template.push({ id: 't' + Date.now(), title: t.title, subject: t.subject, start: Math.round(t.start), end: Math.round(t.end), note: t.note, reminder: true, advance: 5, flex: true });
  }
  state.template.sort((a, b) => a.start - b.start);
  save(true);
  toast('已写入每日模板 · 明天起生效');
}

/* ---------------- 编辑面板 ---------------- */
function openEditor(t, mode, dateVals) {
  const isTpl = mode === 'template';
  const startVal = hm(isTpl ? t.start : (t.start));
  const endVal = hm(taskEnd(t));
  const subjects = Object.keys(SUBJECTS).filter(s => s !== '休息');
  const html = `
    <div class="sheet-head">
      <div style="flex:1">
        <div class="sheet-eyebrow">${isTpl ? 'TEMPLATE · 每日模板' : 'EDIT · 仅修改今天'}</div>
        <h2 class="sheet-title">调整学习时段</h2>
        <div class="sheet-meta">${isTpl ? '影响之后自动生成的日期' : '只影响今天这一份计划'}</div>
      </div>
      <button class="sheet-close" aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg></button>
    </div>
    <div class="form">
      <div class="field"><label>任务</label><input id="fTitle" value="${escAttr(t.title)}" placeholder="例如 408 真题"></div>
      <div class="field"><label>科目</label>
        <select id="fSubject">${subjects.map(s => `<option value="${s}" ${s === t.subject ? 'selected' : ''}>${s}</option>`).join('')}</select>
      </div>
      <div class="field"><label>开始</label><input type="time" id="fStart" value="${startVal}"></div>
      <div class="field"><label>结束</label><input type="time" id="fEnd" value="${endVal}"></div>
      <div class="field field-col"><label>说明</label><textarea id="fNote" placeholder="这一段时间要完成什么">${esc(t.note || '')}</textarea></div>
      <div class="toggle-row">开始提醒 <label class="switch ${t.reminder !== false ? 'on' : ''}"><input type="checkbox" id="fRemind" ${t.reminder !== false ? 'checked' : ''}><i></i></label></div>
      <div class="toggle-row">允许弹性调整 <label class="switch ${t.flex !== false ? 'on' : ''}"><input type="checkbox" id="fFlex" ${t.flex !== false ? 'checked' : ''}><i></i></label></div>
    </div>
    <div class="sheet-actions">
      <button class="btn btn-ghost" style="flex:1" id="btnCancelEdit">取消</button>
      <button class="btn btn-primary" style="flex:1" id="btnSaveEdit">保存</button>
    </div>`;

  openSheet(html, panel => {
    const syncSwitch = () => {
      panel.querySelectorAll('.toggle-row .switch').forEach(sw => {
        const input = sw.querySelector('input');
        sw.classList.toggle('on', input.checked);
      });
    };
    panel.querySelectorAll('.toggle-row .switch input').forEach(i => i.addEventListener('change', syncSwitch));
    $('#btnCancelEdit', panel).addEventListener('click', () => { haptic('light'); closeSheet(); });
    $('#btnSaveEdit', panel).addEventListener('click', () => {
      const title = $('#fTitle', panel).value.trim() || '学习任务';
      const subject = $('#fSubject', panel).value;
      const st = toMinutes($('#fStart', panel).value, t.start);
      const en = toMinutes($('#fEnd', panel).value, taskEnd(t));
      const note = $('#fNote', panel).value.trim();
      const remind = $('#fRemind', panel).checked;
      const flex = $('#fFlex', panel).checked;
      if (en <= st) { toast('结束时间需要晚于开始时间'); return; }
      if (isTpl) {
        const tpl = state.template.find(x => x.id === t.id);
        if (tpl) {
          Object.assign(tpl, { title, subject, start: st, end: en, note, reminder: remind, flex });
          state.template.sort((a, b) => a.start - b.start);
        }
        toast('模板已更新 · 明天起生效');
      } else {
        Object.assign(t, { title, subject, start: st, end: en, note, reminder: remind, flex, modified: true });
        const rec = todayRec();
        if (rec) rec.tasks.sort((a, b) => a.start - b.start);
        toast('今天的计划已更新');
      }
      save(true);
      closeSheet();
      renderHome();
      renderStats();
    });
  });
}

function toMinutes(v, fallback) {
  if (!v || !/^\d{1,2}:\d{2}$/.test(v)) return fallback;
  const [h, m] = v.split(':').map(Number);
  return h * 60 + m;
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function escAttr(s) { return esc(s); }

/* ---------------- 计划列表 ---------------- */
/* 两次点击确认删除：第一次点亮按钮，第二次执行 */
function armDelete(btn, onConfirm) {
  if (btn.classList.contains('armed')) {
    btn.classList.remove('armed');
    onConfirm();
    return;
  }
  btn.classList.add('armed');
  haptic('light');
  toast('再点一次确认删除');
  setTimeout(() => btn.classList.remove('armed'), 2800);
}

const delIconSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 7l1 12a1.6 1.6 0 0 0 1.6 1.5h5.8a1.6 1.6 0 0 0 1.6-1.5l1-12"/></svg>';

function openPlanSheet() {
  const rec = todayRec();
  const tasks = (rec.tasks || []).slice().sort((a, b) => a.start - b.start);
  const rows = tasks.map(t => `
    <div class="row" data-id="${t.id}" style="cursor:pointer">
      <div class="row-icon" style="background:${subjectColor(t.subject)}33;color:${subjectColor(t.subject)};box-shadow:none">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 1.8"/></svg>
      </div>
      <div class="row-body">
        <div class="row-title">${hm(t.start)} · ${esc(t.title)}</div>
        <div class="row-sub">${esc(t.subject)} · ${Math.round(taskDur(t))} 分钟 · ${STATUS_TEXT[t.status]}</div>
      </div>
      <button class="row-del" data-del="${t.id}" aria-label="删除">${delIconSvg}</button>
    </div>`).join('');

  openSheet(`
    <div class="sheet-head">
      <div style="flex:1">
        <div class="sheet-eyebrow">TODAY · ${dateKey(new Date())}</div>
        <h2 class="sheet-title">今日计划</h2>
        <div class="sheet-meta">${tasks.length} 个学习时段 · 点任意一项调整</div>
      </div>
      <button class="sheet-close" aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg></button>
    </div>
    <div class="list-card" style="margin-top:14px">${rows}</div>
    <div class="sheet-actions">
      <button class="btn btn-ghost" style="flex:1" id="toTemplate">编辑每日模板</button>
      <button class="btn btn-primary" style="flex:1" id="resetDay">恢复默认计划</button>
    </div>`, panel => {
    panel.querySelectorAll('.row[data-id]').forEach(row => {
      row.addEventListener('click', () => {
        const t = rec.tasks.find(x => x.id === row.dataset.id);
        if (t) openTaskSheet(t);
      });
    });
    panel.querySelectorAll('.row-del').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        armDelete(btn, () => {
          rec.tasks = rec.tasks.filter(x => x.id !== btn.dataset.del);
          save(true);
          closeSheet();
          renderHome();
          openPlanSheet();
          toast('已从今日计划删除');
        });
      });
    });
    $('#toTemplate', panel).addEventListener('click', () => openTemplateSheet());
    $('#resetDay', panel).addEventListener('click', () => {
      const k = todayKey();
      state.days[k] = { tasks: state.template.map(t => cloneTask(t, k)), createdAt: Date.now() };
      save(true);
      closeSheet();
      renderHome();
      toast('已恢复默认计划');
    });
  });
}

function openTemplateSheet() {
  const rows = state.template.slice().sort((a, b) => a.start - b.start).map(t => `
    <div class="row" data-id="${t.id}" style="cursor:pointer">
      <div class="row-icon" style="background:${subjectColor(t.subject)}33;color:${subjectColor(t.subject)};box-shadow:none">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 1.8"/></svg>
      </div>
      <div class="row-body">
        <div class="row-title">${hm(t.start)} — ${hm(t.end)} · ${esc(t.title)}</div>
        <div class="row-sub">${esc(t.subject)} · 每天重复 · ${t.reminder !== false ? '提醒开启' : '无提醒'}</div>
      </div>
      <button class="row-del" data-del="${t.id}" aria-label="删除">${delIconSvg}</button>
    </div>`).join('');

  openSheet(`
    <div class="sheet-head">
      <div style="flex:1">
        <div class="sheet-eyebrow">TEMPLATE · 每日计划模板</div>
        <h2 class="sheet-title">固定的学习节奏</h2>
        <div class="sheet-meta">模板每天自动复制到新的一天，当天修改不会影响其他日期</div>
      </div>
      <button class="sheet-close" aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg></button>
    </div>
    <div class="list-card" style="margin-top:14px">${rows}</div>
    <div class="sheet-actions">
      <button class="btn btn-ghost" style="flex:1" id="addSlot">添加时段</button>
      <button class="btn btn-primary" style="flex:1" id="syncToday">同步到今日</button>
    </div>`, panel => {
    panel.querySelectorAll('.row[data-id]').forEach(row => {
      row.addEventListener('click', () => {
        const t = state.template.find(x => x.id === row.dataset.id);
        if (t) openEditor(t, 'template');
      });
    });
    panel.querySelectorAll('.row-del').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        armDelete(btn, () => {
          const gone = state.template.find(x => x.id === btn.dataset.del);
          state.template = state.template.filter(x => x.id !== btn.dataset.del);
          save(true);
          closeSheet();
          openTemplateSheet();
          toast(gone ? `已删除「${gone.title}」· 明天起不再生成` : '已删除该时段');
        });
      });
    });
    $('#addSlot', panel).addEventListener('click', () => {
      const last = state.template.slice().sort((a, b) => b.end - a.end)[0];
      const st = last ? Math.min(last.end, 1380) : 480;
      const t = { id: 't' + Date.now(), title: '新的学习时段', subject: '其他', start: st, end: Math.min(st + 60, 1439), note: '', reminder: true, advance: 5, flex: true };
      state.template.push(t);
      save(true);
      openEditor(t, 'template');
    });
    $('#syncToday', panel).addEventListener('click', () => {
      const k = todayKey();
      const rec = state.days[k];
      if (!rec) return;
      const dones = rec.tasks.filter(t => t.status === 'done' || t.status === 'skipped' || t.modified);
      const fresh = state.template.map(t => {
        const kept = dones.find(d => d.id === t.id);
        return kept ? kept : cloneTask(t, k);
      });
      state.days[k] = { tasks: fresh.sort((a, b) => a.start - b.start), createdAt: Date.now() };
      save(true);
      closeSheet();
      renderHome();
      toast('今日已同步模板');
    });
  });
}

/* ---------------- 番茄钟 ---------------- */
const POMO_FOCUS = { 25: 1500, 50: 3000, 15: 900 };
const POMO_BREAK = { 25: 300, 50: 600, 15: 180 };
const POMO_C = 2 * Math.PI * 86;

const mmss = s => {
  const v = Math.max(0, Math.floor(s));
  return `${pad(Math.floor(v / 60))}:${pad(v % 60)}`;
};

function pomoTotal() {
  const p = state.pomo;
  const map = p.phase === 'break' ? POMO_BREAK : POMO_FOCUS;
  return map[p.preset] || (p.phase === 'break' ? 300 : 1500);
}
function pomoRemain() {
  const p = state.pomo;
  if (p.running && p.endAt) return Math.max(0, (p.endAt - Date.now()) / 1000);
  return Math.max(0, p.remain);
}
function pomoTodayList() { return state.pomo.sessions[todayKey()] || []; }
function pomoTodayMinutes() {
  return pomoTodayList().reduce((a, s) => a + (s.minutes || 0), 0);
}
function pomoWeekCount() {
  return lastDays(7).reduce((a, k) => a + ((state.pomo.sessions[k] || []).length), 0);
}
function pomoLinkedTask() {
  const rec = todayRec();
  if (!rec) return null;
  const p = state.pomo;
  if (p.taskId) {
    const t = rec.tasks.find(x => x.id === p.taskId);
    if (t) return t;
  }
  const info = currentInfo(rec);
  return info && (info.mode === 'active' || info.mode === 'doing') ? info.task : null;
}

function pomoStart() {
  const p = state.pomo;
  const total = pomoTotal();
  if (p.remain <= .5 || p.remain > total) p.remain = total;
  p.running = true;
  p.endAt = Date.now() + p.remain * 1000;
  p.startAt = Date.now() - (total - p.remain) * 1000;
  if (p.phase === 'focus') {
    const t = pomoLinkedTask();
    p.taskId = t ? t.id : null;
    p.taskTitle = t ? t.title : '';
  }
  save();
  haptic('medium');
  syncGuard();
  renderFocus();
  renderPomoMini();
  if (immerseOpen) renderImmerse();   // 暂停后继续：不要重放入场动画
  else openImmerse();
}

function pomoPause() {
  const p = state.pomo;
  p.remain = pomoRemain();
  p.running = false;
  p.endAt = null;
  p.startAt = null;
  save();
  haptic('light');
  syncGuard();
  renderFocus();
  renderPomoMini();
  if (immerseOpen) renderImmerse();
}

function pomoReset() {
  const p = state.pomo;
  p.running = false;
  p.endAt = null;
  p.startAt = null;
  p.phase = 'focus';
  p.remain = pomoTotal();
  save();
  syncGuard();
  renderFocus();
  renderPomoMini();
  if (immerseOpen) renderImmerse();
}

function pomoSkip() {
  const p = state.pomo;
  p.running = false;
  p.endAt = null;
  p.startAt = null;
  p.taskId = null;
  p.taskTitle = '';
  p.phase = p.phase === 'focus' ? 'break' : 'focus';
  p.remain = pomoTotal();
  save();
  haptic('light');
  syncGuard();
  renderFocus();
  renderPomoMini();
  if (immerseOpen) renderImmerse();
  toast(p.phase === 'break' ? '跳过本轮 · 先休息一下' : '休息结束 · 回到专注');
}

function pomoFinish() {
  const p = state.pomo;
  const wasBreak = p.phase === 'break';
  const minutes = Math.round(pomoTotal() / 60);
  // 用计划结束时刻记录，而不是"发现到点"的时刻：
  // 息屏后 JS 定时器可能晚醒十几分钟，用 Date.now() 会让时长和落点都漂
  const endedAt = p.endAt || Date.now();

  if (!wasBreak) {
    const key = todayKey();
    const list = p.sessions[key] || (p.sessions[key] = []);
    list.push({
      start: p.startAt || endedAt - minutes * 60000,
      end: endedAt,
      minutes,
      taskId: p.taskId || null,
      title: p.taskTitle || '自由专注'
    });
    p.round = (p.round || 0) + 1;
    if (p.taskId) {
      const rec = todayRec();
      const t = rec && rec.tasks.find(x => x.id === p.taskId);
      if (t) {
        t.pomoAcc = (t.pomoAcc || 0) + minutes * 60;
        t.pomoCount = (t.pomoCount || 0) + 1;
      }
    }
  }

  p.phase = wasBreak ? 'focus' : 'break';
  p.remain = pomoTotal();
  p.startAt = null;
  p.taskId = null;
  p.taskTitle = '';
  if (p.auto) {
    p.running = true;
    p.endAt = Date.now() + p.remain * 1000;
    p.startAt = Date.now();
  } else {
    p.running = false;
    p.endAt = null;
  }
  save(true);
  pomoChime();
  haptic('success');
  syncGuard();
  toast(wasBreak ? '休息结束 · 开始下一轮专注' : `完成一个番茄 · ${minutes} 分钟`);
  renderHome();
  renderFocus();
  renderStats();
  if (immerseOpen) {
    if (p.auto) renderImmerse();
    else closeImmerse();
  }
}

let pomoAudio = null;
function pomoChime() {
  if (!state.pomo.sound) return;
  if (navigator.vibrate) navigator.vibrate([30, 60, 30]);
  try {
    pomoAudio = pomoAudio || new (window.AudioContext || window.webkitAudioContext)();
    const now = pomoAudio.currentTime;
    [880, 1174].forEach((f, i) => {
      const o = pomoAudio.createOscillator(), g = pomoAudio.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0, now + i * .18);
      g.gain.linearRampToValueAtTime(.12, now + i * .18 + .02);
      g.gain.exponentialRampToValueAtTime(.0001, now + i * .18 + .42);
      o.connect(g);
      g.connect(pomoAudio.destination);
      o.start(now + i * .18);
      o.stop(now + i * .18 + .46);
    });
  } catch (e) {}
}

function moveGlider(container, glider, btn) {
  if (!container || !glider || !btn) return;
  requestAnimationFrame(() => {
    glider.style.width = btn.offsetWidth + 'px';
    glider.style.transform = `translateX(${btn.offsetLeft - 4}px)`;
  });
}

function setPomoPreset(v) {
  const p = state.pomo;
  if (p.preset === v && !p.running) return;
  p.preset = v;
  p.phase = 'focus';
  p.remain = v * 60;
  p.running = false;
  p.endAt = null;
  p.startAt = null;
  save(true);
  haptic('light');
  renderFocus();
  renderPomoMini();
  toast(`番茄节奏 · ${v} 分钟专注`);
}


/* ---------------- 极简专注界面 ---------------- */
const FOCUS_LINES = [
  '别想太多，先做二十五分钟。',
  '你不需要状态，你只需要开始。',
  '这一轮只做一件事。',
  '慢一点没关系，别停下来。',
  '把手机放远一点，把书拉近一点。',
  '注意力是这年头最贵的东西，别随手送人。',
  '你不是在熬时间，你是在攒筹码。',
  '再坚持十分钟，感觉会不一样。',
  '现在的每一分钟，都是给明年自己的。',
  '一天不需要完美，只需要推进。',
  '累了就慢一点，但别关掉计时。',
  '做完这一段，你就有资格休息。'
];
const BREAK_LINES = [
  '站起来，走两步，看看远处。',
  '眼睛离开屏幕，喝口水。',
  '休息也是计划的一部分。',
  '别刷手机，那不算休息。'
];

let immerseOpen = false;

function immerseLine(phase, remain, total) {
  const list = phase === 'break' ? BREAK_LINES : FOCUS_LINES;
  const elapsed = Math.max(0, total - remain);
  return list[Math.floor(elapsed / 45) % list.length];   // 每 45 秒换一句，不打断阅读
}

function renderImmerse() {
  const el = $('#immerse');
  if (!el) return;
  const p = state.pomo;
  const isBreak = p.phase === 'break';
  const remain = pomoRemain();
  const total = pomoTotal();

  $('#imEyebrow').textContent = isBreak ? 'BREAK · 休息' : 'FOCUS · 专注';
  $('#imTime').textContent = mmss(remain);
  $('#imLine').textContent = immerseLine(p.phase, remain, total);
  $('#imPause').textContent = p.running
    ? (isBreak ? '暂停休息' : '暂停')
    : (isBreak ? '继续休息' : '继续');
  $('#imTask').textContent = isBreak
    ? (p.round ? `已完成 ${p.round} 个番茄` : '休息一下，再回来')
    : (p.taskTitle || '自由专注 · 不绑定具体任务');
  $('#imBar').style.width = (100 - clamp(remain / total, 0, 1) * 100).toFixed(2) + '%';
}

function openImmerse() {
  const el = $('#immerse');
  if (!el) return;
  immerseOpen = true;
  el.classList.add('open');
  el.setAttribute('aria-hidden', 'false');
  renderImmerse();
  $('#imBar').style.width = '0%';
  requestAnimationFrame(() => {
    const p = state.pomo;
    const remain = pomoRemain();
    $('#imBar').style.width = (100 - clamp(remain / pomoTotal(), 0, 1) * 100).toFixed(2) + '%';
  });
}

function closeImmerse() {
  const el = $('#immerse');
  if (!el) return;
  immerseOpen = false;
  el.classList.remove('open');
  el.setAttribute('aria-hidden', 'true');
}

/** 每秒同步一次（由 tickPomo 调用），只改会变的两个东西 */
function tickImmerse() {
  if (!immerseOpen) return;
  const p = state.pomo;
  const remain = pomoRemain();
  const total = pomoTotal();
  const t = $('#imTime');
  if (t) t.textContent = mmss(remain);
  const bar = $('#imBar');
  if (bar) bar.style.width = (100 - clamp(remain / total, 0, 1) * 100).toFixed(2) + '%';
  const line = $('#imLine');
  const next = immerseLine(p.phase, remain, total);
  if (line && line.textContent !== next) line.textContent = next;
}

/* ---------------- 极度沉浸（强制专注） ---------------- */
function usageAccessGranted() {
  const n = N();
  if (!n || !n.usageAccessGranted) return false;
  try { return !!n.usageAccessGranted(); } catch (e) { return false; }
}

function overlayGranted() {
  const n = N();
  if (!n || !n.overlayGranted) return false;
  try { return !!n.overlayGranted(); } catch (e) { return false; }
}

function guardReady() { return usageAccessGranted() && overlayGranted(); }

let guardPendingStart = false;

/**
 * 当前这一轮需要守护的时间段。
 * 番茄钟和「任务计时」两种模式都算——之前只认番茄钟，
 * 但界面写的是"专注期间自动屏蔽"，用户点任务上的开始却不会被拦。
 */
function guardSession() {
  const p = state.pomo;
  if (!p.guard) return null;

  if (p.running && p.phase === 'focus' && p.endAt && p.endAt > Date.now()) {
    return {
      endAt: p.endAt,
      title: p.taskTitle || '',
      minutes: Math.round(pomoTotal() / 60)
    };
  }

  const rec = todayRec();
  if (!rec) return null;
  const t = rec.tasks.find(x => x.focusStart);
  if (!t) return null;
  const endMs = parseKey(todayKey()).getTime() + taskEnd(t) * 60000;
  if (endMs <= Date.now() + 5000) return null;
  return {
    endAt: endMs,
    title: t.title || '',
    minutes: Math.max(1, Math.round((endMs - (t.focusStart || Date.now())) / 60000))
  };
}

function syncGuard() {
  const n = N();
  if (!n || !n.startFocusGuard) return;
  const s = guardSession();
  if (!s) {
    guardPendingStart = false;
    try { n.stopFocusGuard(); } catch (e) {}
    return;
  }
  if (!guardReady()) {
    guardPendingStart = true;
    try { n.stopFocusGuard(); } catch (e) {}
    return;
  }
  guardPendingStart = false;
  try { n.startFocusGuard(JSON.stringify(s)); } catch (e) {}
  updateGuardRow();
}

function updateGuardRow() {
  const sub = $('#guardSub');
  const sw = $('#setGuard');
  const p = state.pomo;
  const usage = usageAccessGranted();
  const overlay = overlayGranted();
  const active = !!guardSession() && usage && overlay;
  const n = N();
  if (sw) sw.checked = !!p.guard;

  if (sub) {
    if (active && (!usage || !overlay)) {
      sub.textContent = !usage ? '缺少「使用情况访问」· 到设置里开启' : '缺少「显示在其他应用上层」· 到设置里开启';
    } else if (active) {
      const alive = n && n.guardRunning ? !!n.guardRunning() : true;
      sub.textContent = alive
        ? '屏蔽中 · 切到无关应用会被立即盖住'
        : '守护未运行 · 开关关掉再打开可重启';
    } else if (p.guard && !(usage && overlay)) {
      sub.textContent = '权限未齐 · 需开启使用情况访问与悬浮窗';
    } else if (p.guard) {
      sub.textContent = '已就绪 · 开始专注后生效';
    } else {
      sub.textContent = '专注期间自动屏蔽无关应用';
    }
  }

  // 首页同款开关跟随状态
  const homeSw = $('#homeGuard');
  if (homeSw) homeSw.checked = !!p.guard;
  const homeSub = $('#homeGuardSub');
  if (homeSub) homeSub.textContent = guardText(!!p.guard, active);
}

/** 统一设置极度沉浸开关（专注页与首页共用） */
function setGuardEnabled(on) {
  state.pomo.guard = !!on;
  save(true);
  haptic('light');
  const n = N();
  if (on && n && !usageAccessGranted()) {
    toast('先开启「使用情况访问」权限');
    if (n.openUsageAccessSettings) { try { n.openUsageAccessSettings(); } catch (e) {} }
  } else if (on && n && !overlayGranted()) {
    toast('再开启「显示在其他应用上层」权限');
    if (n.openOverlaySettings) { try { n.openOverlaySettings(); } catch (e) {} }
  } else if (on) {
    toast(state.pomo.running ? '极度沉浸已开启 · 开始屏蔽无关应用' : '极度沉浸已开启 · 开始专注后生效');
  } else {
    toast('极度沉浸已关闭');
  }
  // 只切换守护，不暂停计时
  syncGuard();
  updateGuardRow();
}

function bindGuard() {
  const sw = $('#setGuard');
  if (!sw) return;
  sw.addEventListener('change', () => setGuardEnabled(sw.checked));
}

/* ---------------- 账户（本地版 · Resend 就绪） ---------------- */
const USERS_KEY = 'chronos.users.v1';
const CODES_KEY = 'chronos.codes.v1';

const AVATAR_GRADS = [
  ['#ff8a5c', '#ff5a1f'], ['#5c8fff', '#3478f6'], ['#9b7bff', '#7b52dd'],
  ['#3fcf8e', '#1fae6e'], ['#ffb340', '#f59e0b'], ['#ff6b9e', '#f43f75'],
  ['#42c8d8', '#1a9ec0'], ['#8ec31a', '#65a30d'], ['#c86bff', '#a855f7'],
  ['#ff7a45', '#e04f1f'], ['#4fb3ff', '#2196f3'], ['#66d1a3', '#34a97b']
];

/** 头像：优先用自定义图片，否则用渐变色 + 首字母 */
function avatarHtml(u, cls) {
  const user = u || {};
  if (user.avatarData) {
    return `<span class="avatar-circle ${cls || ''} avatar-photo"><img src="${user.avatarData}" alt=""></span>`;
  }
  const i = typeof user.avatar === 'number' ? user.avatar : 0;
  const g = AVATAR_GRADS[((i || 0) + AVATAR_GRADS.length) % AVATAR_GRADS.length];
  const raw = (user.nickname || user.email || '?').trim();
  const letter = raw.charAt(0).toUpperCase() || '?';
  return `<span class="avatar-circle ${cls || ''}" style="background:linear-gradient(135deg,${g[0]},${g[1]})">${esc(letter)}</span>`;
}
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch (e) { return fallback; }
}
function writeJson(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
}

function requestCodeFor(email) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const store = readJson(CODES_KEY, {});
  store[email] = { code, exp: Date.now() + 10 * 60 * 1000 };
  writeJson(CODES_KEY, store);
  const n = N();
  let mode = 'dev';
  try { if (n && n.sendEmailCode) mode = n.sendEmailCode(email, code) || 'dev'; } catch (e) { mode = 'dev'; }
  return { code, mode };
}
function verifyCodeFor(email, code) {
  const store = readJson(CODES_KEY, {});
  const rec = store[email];
  if (!rec) return false;
  if (Date.now() > rec.exp) {
    delete store[email];
    writeJson(CODES_KEY, store);
    return false;
  }
  if (String(rec.code) !== String(code).trim()) {
    rec.tries = (rec.tries || 0) + 1;
    if (rec.tries >= 5) delete store[email];   // 试错上限，挡一下暴力猜
    writeJson(CODES_KEY, store);
    return false;
  }
  delete store[email];                          // 一次性：用过即失效
  writeJson(CODES_KEY, store);
  return true;
}

function setUser(u) {
  state.user = u ? {
    email: u.email,
    nickname: u.nickname || '',
    phone: u.phone || '',
    avatar: typeof u.avatar === 'number' ? u.avatar : 0,
    avatarData: u.avatarData || null
  } : null;
  save(true);
  renderAccountUI();
}

function renderAccountUI() {
  const card = $('#profileCard');
  const u = state.user;
  if (card) {
    if (u) {
      card.innerHTML = `
        ${avatarHtml(u, 'avatar-lg')}
        <div class="profile-body">
          <b class="profile-name">${esc(u.nickname || '未命名')}</b>
          <span class="profile-mail">${esc(u.email)}</span>
          ${u.phone ? `<span class="profile-phone">${esc(u.phone)}</span>` : ''}
        </div>
        <button class="pill-btn" data-acct="manage">管理</button>`;
      card.onclick = e => {
        haptic('light');
        openProfileSheet();
      };
    } else {
      card.innerHTML = `
        <span class="avatar-circle avatar-lg avatar-dashed">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="8" r="3.6"/><path d="M5 19c.8-3.4 3.6-5 7-5s6.2 1.6 7 5"/></svg>
        </span>
        <div class="profile-body">
          <b class="profile-name">未登录</b>
          <span class="profile-mail">邮箱验证码登录 · 数据保存在本机</span>
        </div>
        <button class="pill-btn" data-acct="login">登录 / 注册</button>`;
      card.onclick = e => {
        haptic('light');
        openAuthSheet();
      };
    }
  }
}

function openAuthSheet() {
  let cooldown = 0;
  let sentCode = null;
  let sentMode = 'dev';
  const html = `
    <div class="sheet-head">
      <div style="flex:1">
        <div class="sheet-eyebrow">ACCOUNT · 账户</div>
        <h2 class="sheet-title">登录 / 注册</h2>
        <div class="sheet-meta">邮箱验证码登录，未注册将自动创建账号</div>
      </div>
      <button class="sheet-close" aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg></button>
    </div>
    <div class="form">
      <div class="field"><label>邮箱</label><input id="auEmail" type="email" inputmode="email" placeholder="you@example.com"></div>
      <div class="field field-row">
        <input id="auCode" type="text" inputmode="numeric" maxlength="6" placeholder="6 位验证码">
        <button class="pill-btn" id="auSend">获取验证码</button>
      </div>
      <div class="auth-hint" id="auHint" hidden></div>
    </div>
    <div class="sheet-actions">
      <button class="btn btn-primary" id="auNext">下一步</button>
    </div>`;

  openSheet(html, panel => {
    const emailIn = $('#auEmail', panel);
    const codeIn = $('#auCode', panel);
    const sendBtn = $('#auSend', panel);
    const hint = $('#auHint', panel);
    emailIn.focus && setTimeout(() => emailIn.focus(), 350);

    const startCooldown = () => {
      cooldown = 60;
      sendBtn.classList.add('cool');
      const tick = () => {
        if (!document.body.contains(sendBtn)) return;
        if (cooldown <= 0) { sendBtn.textContent = '重新获取'; sendBtn.classList.remove('cool'); return; }
        sendBtn.textContent = cooldown + 's';
        cooldown--;
        setTimeout(tick, 1000);
      };
      tick();
    };

    sendBtn.addEventListener('click', () => {
      const email = emailIn.value.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast('请输入有效的邮箱地址'); return; }
      const r = requestCodeFor(email);
      sentCode = r.code; sentMode = r.mode;
      haptic('light');
      startCooldown();
      if (r.mode === 'sent') {
        hint.hidden = false;
        hint.textContent = `验证码已发送到 ${email}，10 分钟内有效`;
        toast('验证码已发送 · 查收邮箱');
      } else {
        hint.hidden = false;
        hint.textContent = `本机模式 · 验证码 ${r.code}（未接邮箱服务，仅本机校验）`;
        toast('开发模式 · 验证码见下方提示');
      }
    });

    $('#auNext', panel).addEventListener('click', () => {
      const email = emailIn.value.trim().toLowerCase();
      const code = codeIn.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast('请输入有效的邮箱地址'); return; }
      if (!/^\d{6}$/.test(code)) { toast('请输入 6 位验证码'); return; }
      if (!verifyCodeFor(email, code)) { toast('验证码不正确或已过期'); return; }
      const users = readJson(USERS_KEY, {});
      if (users[email]) {
        setUser({ ...users[email], email });
        closeSheet();
        toast(`欢迎回来 · ${users[email].nickname || email}`);
      } else {
        openRegisterStep(email);
      }
    });
  });
}

function openRegisterStep(email) {
  const html = `
    <div class="sheet-head">
      <div style="flex:1">
        <div class="sheet-eyebrow">REGISTER · 新账号</div>
        <h2 class="sheet-title">创建账号</h2>
        <div class="sheet-meta">${esc(email)} · 尚未注册</div>
      </div>
      <button class="sheet-close" aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg></button>
    </div>
    <div class="form">
      <div class="field"><label>昵称</label><input id="rgName" maxlength="12" placeholder="怎么称呼你"></div>
      <div class="field"><label>手机号（可选）</label><input id="rgPhone" type="tel" inputmode="tel" maxlength="20" placeholder="仅保存在本机"></div>
    </div>
    <div class="sheet-actions">
      <button class="btn btn-primary" id="rgCreate">创建账号</button>
    </div>`;
  openSheet(html, panel => {
    setTimeout(() => $('#rgName', panel).focus(), 350);
    $('#rgCreate', panel).addEventListener('click', () => {
      const nickname = $('#rgName', panel).value.trim();
      const phone = $('#rgPhone', panel).value.trim();
      if (!nickname) { toast('给自己起个昵称吧'); return; }
      const users = readJson(USERS_KEY, {});
      const u = { email, nickname, phone, avatar: hashStr(email) % AVATAR_GRADS.length, createdAt: Date.now() };
      users[email] = u;
      writeJson(USERS_KEY, users);
      const codes = readJson(CODES_KEY, {});
      delete codes[email];
      writeJson(CODES_KEY, codes);
      setUser({ ...u, email });
      closeSheet();
      toast('账号已创建 · 欢迎使用时序');
    });
  });
}

function openProfileSheet() {
  const u = state.user;
  if (!u) { openAuthSheet(); return; }
  const html = `
    <div class="sheet-head">
      <div style="flex:1">
        <div class="sheet-eyebrow">PROFILE · 资料</div>
        <h2 class="sheet-title">我的账户</h2>
        <div class="sheet-meta">邮箱 ${esc(u.email)}</div>
      </div>
      <button class="sheet-close" aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg></button>
    </div>
    <div class="avatar-section">
      <div class="micro-label">头像</div>
      <div class="avatar-custom">
        <span class="avatar-circle avatar-lg" id="pfPreview"></span>
        <div class="avatar-custom-btns">
          <button class="pill-btn" id="pfUpload">从相册选择</button>
          <button class="pill-btn ghost" id="pfClearUpload">清除</button>
        </div>
      </div>
      <input type="file" id="pfFile" accept="image/*" hidden>
      <div class="micro-label" style="margin-top:16px">或选一个渐变</div>
      <div class="avatar-grid" id="pfGrid"></div>
    </div>
    <div class="form">
      <div class="field"><label>昵称</label><input id="pfName" maxlength="12" value="${escAttr(u.nickname || '')}"></div>
      <div class="field"><label>手机号</label><input id="pfPhone" type="tel" inputmode="tel" maxlength="20" value="${escAttr(u.phone || '')}" placeholder="选填"></div>
    </div>
    <div class="sheet-actions">
      <button class="btn btn-primary" id="pfSave">保存</button>
    </div>
    <button class="btn btn-ghost btn-del" id="pfLogout" style="width:100%;margin-top:10px">退出登录</button>`;

  openSheet(html, panel => {
    const grid = $('#pfGrid', panel);
    const nameIn = $('#pfName', panel);
    const fileIn = $('#pfFile', panel);
    let picked = state.user.avatar || 0;
    let avatarData = state.user.avatarData || null;

    const drawPreview = () => {
      const holder = $('#pfPreview', panel);
      if (!holder) return;
      const tmp = document.createElement('div');
      tmp.innerHTML = avatarHtml({ avatar: picked, avatarData, nickname: nameIn.value || state.user.nickname, email: state.user.email }, 'avatar-lg');
      tmp.firstElementChild.id = 'pfPreview';
      holder.replaceWith(tmp.firstElementChild);
    };
    const drawGrid = () => {
      grid.innerHTML = AVATAR_GRADS.map((g, i) => `
        <button class="avatar-opt ${!avatarData && i === picked ? 'is-picked' : ''}" data-g="${i}" style="background:linear-gradient(135deg,${g[0]},${g[1]})">${!avatarData && i === picked ? '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>' : ''}</button>`).join('');
      grid.querySelectorAll('.avatar-opt').forEach(b => {
        b.addEventListener('click', () => {
          picked = Number(b.dataset.g);
          avatarData = null;
          haptic('light');
          drawGrid();
          drawPreview();
        });
      });
    };
    drawGrid();
    drawPreview();

    $('#pfUpload', panel).addEventListener('click', () => { haptic('light'); fileIn.click(); });
    $('#pfClearUpload', panel).addEventListener('click', () => {
      avatarData = null;
      haptic('light');
      drawGrid();
      drawPreview();
      toast('已改用渐变头像');
    });
    fileIn.addEventListener('change', () => {
      const f = fileIn.files && fileIn.files[0];
      if (!f) return;
      if (f.size > 3 * 1024 * 1024) { toast('图片请小于 3MB'); fileIn.value = ''; return; }
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          // 裁成正方形并压到 256px，避免撑爆本地存储
          const S = 256;
          const cv = document.createElement('canvas');
          cv.width = S; cv.height = S;
          const ctx = cv.getContext('2d');
          const side = Math.min(img.width, img.height);
          const sx = (img.width - side) / 2, sy = (img.height - side) / 2;
          ctx.drawImage(img, sx, sy, side, side, 0, 0, S, S);
          avatarData = cv.toDataURL('image/jpeg', .82);
          drawGrid();
          drawPreview();
          haptic('success');
          toast('头像已就绪 · 记得保存');
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(f);
      fileIn.value = '';
    });

    $('#pfSave', panel).addEventListener('click', () => {
      const users = readJson(USERS_KEY, {});
      const nickname = nameIn.value.trim() || state.user.nickname;
      const phone = $('#pfPhone', panel).value.trim();
      const nu = { ...state.user, nickname, phone, avatar: picked, avatarData };
      users[state.user.email] = nu;
      writeJson(USERS_KEY, users);
      setUser(nu);
      closeSheet();
      toast('资料已保存');
    });
    $('#pfLogout', panel).addEventListener('click', () => {
      setUser(null);
      closeSheet();
      toast('已退出登录 · 数据仍保留在本机');
    });
  });
}

function renderFocus() {
  const p = state.pomo;
  const total = pomoTotal();
  const remain = p.running ? pomoRemain() : p.remain;
  const isBreak = p.phase === 'break';
  const started = remain < total - .5;

  $('#pomoPhase').textContent = isBreak ? 'BREAK · 休息' : 'FOCUS · 专注';
  $('#pomoTime').textContent = mmss(remain);

  if (p.running) {
    $('#pomoSub').textContent = isBreak ? '放空一会儿，别刷手机' : '保持专注 · 别切走';
  } else {
    $('#pomoSub').textContent = started
      ? (isBreak ? '休息已暂停' : '已暂停 · 继续这一段')
      : (isBreak ? '准备休息一下' : '准备好就开始');
  }

  const ringWrap = $('#pomoFill').closest('.pomo-ring');
  ringWrap.classList.toggle('is-break', isBreak);
  $('#pomoFill').style.strokeDashoffset = POMO_C * clamp(remain / total, 0, 1);

  $('#pomoMain').textContent = p.running
    ? (isBreak ? '暂停休息' : '暂停专注')
    : started
      ? (isBreak ? '继续休息' : '继续专注')
      : (isBreak ? '开始休息' : '开始专注');

  $('#pomoSkip').textContent = isBreak ? '跳过休息 · 直接下一轮' : '跳过这一段';

  const cycle = 4;
  const done = (p.round || 0) % cycle;
  const nowIdx = (!isBreak && started) ? done % cycle : -1;
  $('#pomoDots').innerHTML = Array.from({ length: cycle }, (_, i) =>
    `<i class="${i < done ? 'done' : ''}${i === nowIdx ? ' now' : ''}"></i>`).join('');

  const t = pomoLinkedTask();
  $('#pomoTask').innerHTML = t
    ? `当前任务 · <b>${esc(t.title)}</b>`
    : '自由专注 · 不绑定具体任务';

  const list = pomoTodayList();
  $('#pomoSummary').innerHTML = `
    <div class="ps"><i>TODAY</i><b>${list.length}<small>个</small></b></div>
    <div class="ps"><i>FOCUS</i><b>${pomoTodayMinutes()}<small>分</small></b></div>
    <div class="ps"><i>7 DAYS</i><b>${pomoWeekCount()}<small>个</small></b></div>`;

  $('#pomoTodayLegend').textContent = `${list.length} 个`;
  const recent = list.slice(-8).reverse();
  $('#pomoLog').innerHTML = recent.length ? recent.map(s => {
    const d = new Date(s.start);
    return `<div class="pomo-log-row">
      <span class="t">${pad(d.getHours())}:${pad(d.getMinutes())}</span>
      <span class="n">${esc(s.title || '自由专注')}</span>
      <span class="m">${s.minutes}′</span>
    </div>`;
  }).join('') : '<div class="empty-state">今天还没有番茄。<br>点上面的按钮，开始第一段。</div>';

  const keys = lastDays(7);
  const counts = keys.map(k => (state.pomo.sessions[k] || []).length);
  renderPomoBars($('#pomoWeekBars'), keys, counts);

  $$('#pomoPresets button').forEach(b => b.classList.toggle('on', Number(b.dataset.preset) === p.preset));
  moveGlider($('#pomoPresets'), $('#pomoPresetGlider'), $('#pomoPresets button.on'));
  updateGuardRow();
}

function renderPomoBars(container, keys, counts) {
  if (!container) return;
  const max = Math.max(4, ...counts);
  container.innerHTML = keys.map((k, i) => {
    const d = parseKey(k);
    const isToday = k === todayKey();
    const g = barGrad(i);
    return `
      <div class="bar-col ${isToday ? 'is-today' : ''}">
        <div class="bar-val">${counts[i] || ''}</div>
        <div class="bar-track"><div class="bar-fill" data-h="${counts[i] ? clamp(counts[i] / max * 100, 8, 100) : 0}" ${isToday ? '' : `style="background:linear-gradient(180deg,${g[0]},${g[1]})"`}></div></div>
        <div class="bar-label">${isToday ? '今天' : DOW_CN[d.getDay()]}</div>
      </div>`;
  }).join('');
  setTimeout(() => {
    $$('.bar-fill', container).forEach(b => { b.style.height = b.dataset.h + '%'; });
  }, 50);
}

function renderPomoMini() {
  const el = $('#pomoMini');
  if (!el) return;
  const p = state.pomo;
  const total = pomoTotal();
  const remain = p.running ? pomoRemain() : p.remain;
  const isBreak = p.phase === 'break';
  const started = remain < total - .5;
  const guard = !!p.guard;
  const busy = p.running && !isBreak;
  const actText = p.running
    ? (isBreak ? '暂停休息' : '暂停专注')
    : started
      ? (isBreak ? '继续休息' : '继续专注')
      : (isBreak ? '开始休息' : '开始专注');

  el.innerHTML = `
    <div class="fm-head">
      <div>
        <div class="micro-label">FOCUS · 专注</div>
        <div class="fm-title">${p.running ? (isBreak ? '番茄休息中' : '正在专注') : (isBreak ? '准备休息' : '番茄钟')}</div>
      </div>
      <div class="fm-time">${mmss(remain)}</div>
    </div>
    <div class="fm-meta">
      <span>${p.preset} 分钟节奏</span><i></i><span>今日 ${pomoTodayList().length} 个</span>
      ${p.taskTitle && !isBreak ? `<i></i><span class="fm-taskname">${esc(p.taskTitle)}</span>` : ''}
    </div>
    <div class="fm-guard ${guard ? 'is-on' : ''}">
      <span class="fm-shield">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3.5v5c0 4.6-3 8-7 9.5-4-1.5-7-4.9-7-9.5v-5z"/><path d="M9.5 12l2 2 3.5-4"/></svg>
      </span>
      <div class="fm-guard-body">
        <div class="fm-guard-title">极度沉浸</div>
        <div class="fm-guard-sub" id="homeGuardSub">${guardText(guard, busy)}</div>
      </div>
      <label class="switch"><input type="checkbox" id="homeGuard" ${guard ? 'checked' : ''}><i></i></label>
    </div>
    <div class="fm-actions">
      <button class="btn btn-primary" data-fm="toggle">${actText}</button>
      <button class="btn btn-ghost" data-fm="open">专注页</button>
    </div>`;

  const sw = $('#homeGuard', el);
  if (sw) sw.addEventListener('change', () => setGuardEnabled(sw.checked));
  el.onclick = e => {
    const btn = e.target.closest('[data-fm]');
    if (btn) {
      haptic('light');
      if (btn.dataset.fm === 'toggle') {
        if (state.pomo.running) pomoPause(); else pomoStart();
      } else {
        switchTab(1);
      }
      return;
    }
    if (e.target.closest('.fm-guard')) return;
    haptic('light');
    switchTab(1);
  };
}

/** 极度沉浸的状态文案 */
function guardText(on, busy) {
  if (!on) return '番茄钟与任务计时期间自动屏蔽';
  if (!guardReady()) return '权限未齐 · 去设置里开启两项权限';
  return busy ? '屏蔽中 · 切到无关应用会被立即盖住' : '已开启 · 开始计时后生效';
}

function tickPomo() {
  const p = state.pomo;
  if (!p.running || !p.endAt) return;
  const remain = pomoRemain();
  if (remain <= .3) {
    p.remain = 0;
    p.running = false;
    pomoFinish();          // 交给 pomoFinish 读取 p.endAt 作为真实结束时刻
    return;
  }
  const total = pomoTotal();
  const time = $('#pomoTime');
  if (time) time.textContent = mmss(remain);
  const mini = $('#pomoMini .fm-time');
  if (mini) mini.textContent = mmss(remain);
  const ring = $('#pomoFill');
  if (ring) ring.style.strokeDashoffset = POMO_C * clamp(remain / total, 0, 1);
  tickImmerse();
}

/* ---------------- 统计 ---------------- */
function daySummary(rec) {
  if (!rec || !rec.tasks) return { planned: 0, actual: 0, done: 0, total: 0, skipped: 0 };
  const total = rec.tasks.length;
  const done = rec.tasks.filter(t => t.status === 'done').length;
  const skipped = rec.tasks.filter(t => t.status === 'skipped').length;
  const planned = rec.tasks.reduce((a, t) => a + taskDur(t) * 60, 0);
  const actual = rec.tasks.reduce((a, t) => a + taskSeconds(t), 0);
  return { planned, actual, done, total, skipped };
}

function lastDays(n) {
  const out = [];
  const today = new Date();
  for (let i = n - 1; i >= 0; i--) out.push(dateKey(addDays(today, -i)));
  return out;
}

let statsRange = 7;

function renderStats() {
  const range = statsRange;
  const keys = lastDays(range);
  const sums = keys.map(k => daySummary(state.days[k]));
  const totalActual = sums.reduce((a, s) => a + s.actual, 0);
  const totalPlanned = sums.reduce((a, s) => a + s.planned, 0);
  const doneCount = sums.reduce((a, s) => a + s.done, 0);
  const totalCount = sums.reduce((a, s) => a + s.total, 0);
  const rate = totalCount ? Math.round(doneCount / totalCount * 100) : 0;
  const streak = calcStreak();
  // 完成率的分母只含"有记录的日期"，日均也必须同口径，
  // 否则会出现"日均 1.2h / 完成率 87%"这种互相打架的组合
  const activeDays = keys.filter(k => state.days[k]).length || 1;
  const avg = totalActual / activeDays;

  const pomoMap = state.pomo.sessions;
  const pomoCount = keys.reduce((a, k) => a + ((pomoMap[k] || []).length), 0);
  const pomoMins = keys.reduce((a, k) =>
    a + (pomoMap[k] || []).reduce((x, s) => x + (s.minutes || 0), 0), 0);

  $('#statHero').innerHTML = `
    <div class="stat-block">
      <div class="k">${range} 天投入</div>
      <div class="v">${hText(totalActual)}</div>
      <div class="s">日均 ${hText(avg)} · ${activeDays} 天有记录</div>
    </div>
    <div class="stat-block">
      <div class="k">完成率</div>
      <div class="v">${rate}<small>%</small></div>
      <div class="s">${doneCount} / ${totalCount} 个时段</div>
    </div>
    <div class="stat-block">
      <div class="k">连续坚持</div>
      <div class="v">${streak}<small>天</small></div>
      <div class="s">${streak > 0 ? '保持住这个节奏' : '今天开始第一天'}</div>
    </div>
    <div class="stat-block">
      <div class="k">番茄专注</div>
      <div class="v">${pomoCount}<small>个</small></div>
      <div class="s">${pomoMins ? hText(pomoMins * 60) + ' 深度专注' : '去专注页开始第一个'}</div>
    </div>`;

  // 每日柱状
  const maxSec = Math.max(3600 * 8, ...sums.map(s => s.actual));
  $('#barsLabel').textContent = range === 7 ? 'LAST 7 DAYS' : 'LAST 30 DAYS';
  $('#bars').classList.toggle('dense', range > 7);
  $('#bars').innerHTML = keys.map((k, i) => {
    const s = sums[i];
    const hgt = s.actual > 0 ? clamp(s.actual / maxSec * 100, 5, 100) : 0;
    const d = parseKey(k);
    const isToday = k === todayKey();
    const sparse = range > 7 && !isToday && (i % 5 !== 4);
    const label = isToday ? '今天' : (range > 7 ? `${d.getMonth() + 1}/${d.getDate()}` : DOW_CN[d.getDay()]);
    const g = barGrad(i);
    return `
      <div class="bar-col ${isToday ? 'is-today' : ''}">
        <div class="bar-val">${s.actual > 0 && !sparse ? hText(s.actual) : ''}</div>
        <div class="bar-track"><div class="bar-fill" data-h="${hgt}" ${isToday ? '' : `style="background:linear-gradient(180deg,${g[0]},${g[1]})"`}></div></div>
        <div class="bar-label">${sparse ? '' : label}</div>
      </div>`;
  }).join('');

  // 科目分布（当前区间）
  const subjectSec = {};
  Object.keys(SUBJECTS).forEach(s => subjectSec[s] = 0);
  keys.forEach(k => {
    const rec = state.days[k];
    (rec ? rec.tasks : []).forEach(t => {
      if (t.status === 'done' || taskSeconds(t) > 0) {
        const s = t.subject || '其他';
        subjectSec[s] = (subjectSec[s] || 0) + taskSeconds(t);
      }
    });
  });
  const subjArr = Object.keys(subjectSec).filter(s => s !== '休息' && subjectSec[s] > 0)
    .map(s => ({ s, sec: subjectSec[s] })).sort((a, b) => b.sec - a.sec);
  const subjMax = Math.max(1, ...subjArr.map(x => x.sec));
  $('#subjectList').innerHTML = subjArr.length ? subjArr.map(x => `
    <div class="subject-row">
      <div class="subject-name">${x.s}</div>
      <div class="subject-track"><div class="subject-fill" data-w="${clamp(x.sec / subjMax * 100, 6, 100)}" style="background:${subjectColor(x.s)}"></div></div>
      <div class="subject-time">${hText(x.sec)}</div>
    </div>`).join('') : `<div class="empty-state">还没有记录。<br>完成第一个学习时段后，这里会亮起来。</div>`;
  $('#subjectTotal').textContent = subjArr.length
    ? '共 ' + Math.round(subjArr.reduce((a, x) => a + x.sec, 0) / 3600) + ' 小时'
    : '暂无数据';

  // 30 天热力
  const hk = lastDays(30);
  const hact = hk.map(k => daySummary(state.days[k]).actual);
  const hmax = Math.max(1, ...hact);
  $('#heatmap').innerHTML = hk.map((k, i) => {
    const sec = hact[i];
    let lvl = '';
    if (sec > 0) {
      const r = sec / hmax;
      lvl = r > .8 ? 'h4' : r > .55 ? 'h3' : r > .28 ? 'h2' : 'h1';
    }
    return `<div class="heat-cell ${lvl} ${k === todayKey() ? 'is-today' : ''}" title="${k} · ${hText(sec)}"></div>`;
  }).join('');

  // 番茄趋势（近 7 天）
  const pkeys = lastDays(7);
  renderPomoBars($('#statsPomoBars'), pkeys, pkeys.map(k => (pomoMap[k] || []).length));
  $('#pomoWeekLegend').textContent = pomoWeekCount() + ' 个';

  // 深度分析
  const prevKeys = lastDays(range * 2).slice(0, range);
  const prevActual = prevKeys.reduce((a, k) => a + daySummary(state.days[k]).actual, 0);
  const diff = prevActual > 0 ? Math.round((totalActual - prevActual) / prevActual * 100) : null;
  const avgPomo = pomoCount ? Math.round(pomoMins / pomoCount) : 0;
  const bestIdx = sums.reduce((mi, s, i) => s.actual > sums[mi].actual ? i : mi, 0);
  const bestDay = sums.length && sums[bestIdx].actual > 0
    ? DOW_CN[parseKey(keys[bestIdx]).getDay()] + ' · ' + hText(sums[bestIdx].actual)
    : '——';

  $('#insightList').innerHTML = `
    <div class="report-row"><span>日均学习时长</span><b>${hText(avg)}</b></div>
    <div class="report-row"><span>状态最好的时段</span><b>${recSpanAvg()}</b></div>
    <div class="report-row"><span>单日最高投入</span><b>${bestDay}</b></div>
    <div class="report-row"><span>番茄平均时长</span><b>${avgPomo ? avgPomo + ' 分钟' : '——'}</b></div>
    <div class="report-row"><span>较上一周期</span><b>${diff == null ? '——' : (diff >= 0 ? '+' : '') + diff + '%'}</b></div>`;

  // 阶段总结
  const subjBest = subjArr[0] ? subjArr[0].s : '——';
  const win = recSpanAvg();
  $('#reportCard').innerHTML = `
    <div class="micro-label">PERIOD REVIEW</div>
    <h2 class="card-title" style="margin-bottom:14px">近 ${range} 天的投入总结</h2>
    <div class="report-list">
      <div class="report-row"><span>计划投入</span><b>${hText(totalPlanned)}</b></div>
      <div class="report-row"><span>实际投入</span><b>${hText(totalActual)}</b></div>
      <div class="report-row"><span>计划完成率</span><b>${rate}%</b></div>
      <div class="report-row"><span>番茄专注</span><b>${pomoCount} 个 · ${hText(pomoMins * 60)}</b></div>
      <div class="report-row"><span>投入最多的分类</span><b>${subjBest}</b></div>
      <div class="report-row"><span>最稳定的时段</span><b>${win}</b></div>
      <div class="report-row"><span>完成 / 跳过</span><b>${doneCount} / ${sums.reduce((a, s) => a + s.skipped, 0)}</b></div>
    </div>
    ${state.demo ? '<div class="report-row" style="margin-top:12px;font-size:10px;color:var(--ink-3)">含演示数据 · 可在设置中清除</div>' : ''}`;

  setTimeout(() => {
    $$('#bars .bar-fill').forEach(b => { b.style.height = b.dataset.h + '%'; });
    $$('#subjectList .subject-fill').forEach(b => { b.style.width = b.dataset.w + '%'; });
  }, 60);
}

/* ---------------- 卡片详情 ---------------- */

function dRow(a, b, c, d) {
  return `<div class="detail-row"><span class="d-day">${a}</span><span class="d-v">${b}</span><span class="d-v">${c}</span><span class="d-strong">${d}</span></div>`;
}

function dHead(cols) {
  return `<div class="detail-row detail-head"><span>${cols[0]}</span><span class="d-v">${cols[1]}</span><span class="d-v">${cols[2]}</span><span class="d-strong">${cols[3]}</span></div>`;
}

function dTable(inner) {
  return `<div class="detail-table">${inner}</div>`;
}

const monthDay = k => { const d = parseKey(k); return `${d.getMonth() + 1}/${d.getDate()}`; };
const weekDay = k => DOW_CN[parseKey(k).getDay()];

/** 区间内每个分类的投入 */
function categoryTotals(keys) {
  const map = {};
  keys.forEach(k => {
    const rec = state.days[k];
    (rec ? rec.tasks : []).forEach(t => {
      const sec = taskSeconds(t);
      if (sec <= 0) return;
      const s = t.subject || '其他';
      map[s] = (map[s] || 0) + sec;
    });
  });
  return Object.keys(map).map(s => ({ s, sec: map[s] })).sort((a, b) => b.sec - a.sec);
}

/** 番茄记录扁平化 */
function pomoRecords(keys) {
  const out = [];
  keys.forEach(k => {
    (state.pomo.sessions[k] || []).forEach(s => out.push({ ...s, date: k }));
  });
  return out.sort((a, b) => b.start - a.start);
}

function openDetail(kind) {
  const range = statsRange;
  const keys = lastDays(range);
  const sums = keys.map(k => daySummary(state.days[k]));
  const totalActual = sums.reduce((a, s) => a + s.actual, 0);
  const totalPlanned = sums.reduce((a, s) => a + s.planned, 0);
  const doneCount = sums.reduce((a, s) => a + s.done, 0);
  const totalCount = sums.reduce((a, s) => a + s.total, 0);
  const skippedCount = sums.reduce((a, s) => a + s.skipped, 0);
  const rate = totalCount ? Math.round(doneCount / totalCount * 100) : 0;
  const avg = totalActual / range;
  const streak = calcStreak();

  const pomoRecs = pomoRecords(keys);
  const pomoMins = pomoRecs.reduce((a, s) => a + (s.minutes || 0), 0);
  const avgPomo = pomoRecs.length ? Math.round(pomoMins / pomoRecs.length) : 0;

  const activeDays = sums.filter(s => s.actual > 0).length;
  let bestIdx = 0;
  sums.forEach((s, i) => { if (s.actual > sums[bestIdx].actual) bestIdx = i; });
  const bestDay = sums.length && sums[bestIdx].actual > 0
    ? `${monthDay(keys[bestIdx])} · ${weekDay(keys[bestIdx])} · ${hText(sums[bestIdx].actual)}`
    : '——';

  let title = '', eyebrow = '', meta = '', body = '';

  if (kind === 'overview') {
    eyebrow = 'OVERVIEW · 总览';
    title = `近 ${range} 天数据`;
    meta = `活跃 ${activeDays} 天 · 平均每天 ${hText(avg)}`;
    body = dTable(
      dHead(['项目', '数值', '', '占比'])
      + dRow('实际投入', '', '', hText(totalActual))
      + dRow('计划投入', '', '', hText(totalPlanned))
      + dRow('完成时段', `${doneCount} 个`, `跳过 ${skippedCount} 个`, `${rate}%`)
      + dRow('连续坚持', '', '', `${streak} 天`)
      + dRow('番茄专注', `${pomoRecs.length} 个`, `均 ${avgPomo} 分`, hText(pomoMins * 60))
      + dRow('活跃天数', `${activeDays} / ${range}`, '', `${Math.round(activeDays / range * 100)}%`)
    ) + `<div class="detail-note">计划完成率 = 已完成时段 ÷ 全部时段；活跃天数指当天有实际投入记录。</div>`;
  } else if (kind === 'daily') {
    eyebrow = 'DAILY · 每日';
    title = '每日投入明细';
    meta = `近 ${range} 天 · 共 ${hText(totalActual)}`;
    const rows = keys.slice().reverse().map((k, idx) => {
      const s = sums[range - 1 - idx];
      if (range === 7 || s.actual > 0) {
        return dRow(
          k === todayKey() ? `今天 · ${monthDay(k)}` : `${monthDay(k)} · ${weekDay(k)}`,
          hText(s.actual),
          `${s.done}/${s.total}`,
          hText(s.planned)
        );
      }
      return '';
    }).join('');
    body = dTable(dHead(['日期', '实际', '完成', '计划']) + rows)
      + `<div class="detail-note">「完成」为已完成时段数 ÷ 当天时段总数。</div>`;
  } else if (kind === 'category') {
    eyebrow = 'CATEGORY · 分类';
    title = '分类投入明细';
    meta = `近 ${range} 天 · 共 ${hText(totalActual)}`;
    const cats = categoryTotals(keys);
    const total = cats.reduce((a, x) => a + x.sec, 0) || 1;
    body = cats.length
      ? dTable(
        dHead(['分类', '时段', '占比', '时长'])
        + cats.map(c => {
          const n = keys.reduce((a, k) => a + ((state.days[k] || {}).tasks || [])
            .filter(t => (t.subject || '其他') === c.s && taskSeconds(t) > 0).length, 0);
          return dRow(
            `<i class="d-dot" style="background:${subjectColor(c.s)}"></i>${esc(c.s)}`,
            `${n} 个`,
            `${Math.round(c.sec / total * 100)}%`,
            hText(c.sec)
          );
        }).join('')
      )
      : `<div class="empty-state">这个区间还没有投入记录。<br>完成第一个时段后再来看。</div>`;
    if (cats.length) body += `<div class="detail-note">统计口径：仅计入实际投入大于 0 的时段。</div>`;
  } else if (kind === 'rhythm') {
    const hk = lastDays(30);
    const hs = hk.map(k => daySummary(state.days[k]));
    const hTotal = hs.reduce((a, s) => a + s.actual, 0);
    const hActive = hs.filter(s => s.actual > 0).length;
    eyebrow = 'RHYTHM · 节奏';
    title = '30 天节奏明细';
    meta = `活跃 ${hActive} / 30 天 · 累计 ${hText(hTotal)}`;
    const recent = hk.slice().reverse().filter(k => daySummary(state.days[k]).actual > 0).slice(0, 14);
    body = dTable(
      dHead(['最近记录', '实际', '完成', '计划'])
      + (recent.length ? recent.map(k => {
        const s = daySummary(state.days[k]);
        return dRow(`${monthDay(k)} · ${weekDay(k)}`, hText(s.actual), `${s.done}/${s.total}`, hText(s.planned));
      }).join('') : '')
    ) + (recent.length ? '' : `<div class="empty-state">最近 30 天还没有投入记录。</div>`)
      + `<div class="detail-note">热力格颜色越深，表示当天实际投入越多（按 30 天内最高值归一）。</div>`;
  } else if (kind === 'pomo' || kind === 'pomoWeek' || kind === 'pomoSummary') {
    const pk = kind === 'pomo' ? lastDays(range) : lastDays(7);
    const recs = pomoRecords(pk);
    const mins = recs.reduce((a, s) => a + (s.minutes || 0), 0);
    eyebrow = 'POMODORO · 番茄';
    title = kind === 'pomoSummary' ? '番茄数据明细' : (kind === 'pomo' ? `近 ${range} 天番茄` : '近 7 天番茄');
    meta = `${recs.length} 个 · 累计 ${hText(mins * 60)}${recs.length ? ` · 均 ${Math.round(mins / recs.length)} 分` : ''}`;
    const dayRows = pk.slice().reverse().map(k => {
      const list = state.pomo.sessions[k] || [];
      const m = list.reduce((a, s) => a + (s.minutes || 0), 0);
      if (!list.length && kind !== 'pomo') return '';
      return dRow(k === todayKey() ? `今天 · ${monthDay(k)}` : `${monthDay(k)} · ${weekDay(k)}`, `${list.length} 个`, hText(m * 60), '');
    }).join('');
    body = dTable(dHead(['日期', '个数', '时长', '']) + dayRows);
    if (recs.length) {
      body += `<div class="micro-label" style="margin:18px 0 8px">最近记录</div>` + dTable(
        dHead(['时间', '任务', '', '时长'])
        + recs.slice(0, 12).map(s => {
          const d = new Date(s.start);
          return dRow(
            `${monthDay(s.date)} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
            esc(s.title || '自由专注'),
            '',
            `${s.minutes}′`
          );
        }).join('')
      );
    } else {
      body += `<div class="empty-state">还没有番茄记录。<br>去专注页开始第一个。</div>`;
    }
  } else if (kind === 'pomoLog') {
    const list = pomoTodayList().slice().sort((a, b) => b.start - a.start);
    eyebrow = 'TODAY · 今日';
    title = '今日番茄记录';
    meta = `${list.length} 个 · ${hText(pomoTodayMinutes() * 60)}`;
    body = list.length
      ? dTable(
        dHead(['时间', '任务', '', '时长'])
        + list.map(s => {
          const d = new Date(s.start);
          return dRow(`${pad(d.getHours())}:${pad(d.getMinutes())}`, esc(s.title || '自由专注'), '', `${s.minutes}′`);
        }).join('')
      )
      : `<div class="empty-state">今天还没有番茄。<br>点上面的按钮，开始第一段。</div>`;
  } else if (kind === 'insight') {
    eyebrow = 'INSIGHTS · 分析';
    title = '这些数字怎么来的';
    meta = '统计口径与本期结论';
    const prevActual = lastDays(range * 2).slice(0, range)
      .reduce((a, k) => a + daySummary(state.days[k]).actual, 0);
    const diff = prevActual > 0 ? Math.round((totalActual - prevActual) / prevActual * 100) : null;
    const cats = categoryTotals(keys);
    body = `<div class="report-list">
      <div class="report-row"><span>日均投入</span><b>${hText(avg)}</b></div>
      <div class="report-row"><span>投入最多分类</span><b>${cats[0] ? esc(cats[0].s) + ' · ' + hText(cats[0].sec) : '——'}</b></div>
      <div class="report-row"><span>更活跃的时段</span><b>${recSpanAvg()}</b></div>
      <div class="report-row"><span>与上一周期相比</span><b>${diff == null ? '——' : (diff >= 0 ? '+' : '') + diff + '%'}</b></div>
      <div class="report-row"><span>单日最高投入</span><b>${bestDay}</b></div>
      <div class="report-row"><span>番茄平均时长</span><b>${avgPomo ? avgPomo + ' 分钟' : '——'}</b></div>
    </div>
    <div class="detail-note">「上一周期」取紧邻的同等长度区间做对比；番茄平均时长只统计已完成并记录的番茄。</div>`;
  } else {
    return;
  }

  openSheet(`
    <div class="sheet-head">
      <div style="flex:1">
        <div class="sheet-eyebrow">${eyebrow}</div>
        <h2 class="sheet-title">${title}</h2>
        <div class="sheet-meta">${meta}</div>
      </div>
      <button class="sheet-close" aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg></button>
    </div>
    <div class="detail-wrap">${body}</div>`);
}

function bindDetailCards() {
  $$('.tap-card').forEach(el => {
    el.addEventListener('click', () => {
      const kind = el.dataset.detail;
      if (!kind) return;
      haptic('light');
      openDetail(kind);
    });
  });
}

function recSpanAvg() {
  let m = 0, a = 0, e = 0;
  Object.values(state.days).forEach(rec => {
    (rec.tasks || []).forEach(t => {
      const sec = taskSeconds(t);
      if (sec <= 0) return;
      if (t.start < 720) m += sec;
      else if (t.start < 1020) a += sec;
      else e += sec;
    });
  });
  if (!m && !a && !e) return '——';
  if (m >= a && m >= e) return '上午';
  if (a >= e) return '下午';
  return '晚上';
}

function calcStreak() {
  let count = 0;
  const today = new Date();
  for (let i = 0; i < 365; i++) {
    const k = dateKey(addDays(today, -i));
    const s = daySummary(state.days[k]);
    if (s.done > 0) count++;
    else if (i === 0) continue;
    else break;
  }
  return count;
}

/* ---------------- 设置 ---------------- */
function applyTheme() {
  const dark = state.theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.body.classList.toggle('motion', !!state.motion);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#0f0f12' : '#f2f2f4');
  const n = N();
  if (n && n.setTheme) { try { n.setTheme(dark ? 'dark' : 'light'); } catch (e) {} }
}

function bindSettings() {
  $('#setReminder').checked = state.remind;
  $('#setAdvance').value = String(state.advance);
  $('#setDark').checked = state.theme === 'dark';
  $('#setMotion').checked = state.motion;
  $('#setPomoPreset').value = String(state.pomo.preset);
  $('#setPomoAuto').checked = state.pomo.auto;
  $('#setPomoSound').checked = state.pomo.sound;
  $('#tplSummary').textContent = `${state.template.length} 个时段 · ${hText(state.template.reduce((a, t) => a + Math.max(0, t.end - t.start) * 60, 0))}`;

  $('#setReminder').addEventListener('change', e => {
    state.remind = e.target.checked;
    save(true); haptic('light');
    toast(state.remind ? '提醒已开启' : '提醒已关闭');
    checkPermissions();
  });
  $('#setAdvance').addEventListener('change', e => {
    state.advance = Number(e.target.value);
    save(true);
    toast(state.advance ? `提前 ${state.advance} 分钟提醒` : '已关闭提前提醒');
  });
  $('#setDark').addEventListener('change', e => {
    state.theme = e.target.checked ? 'dark' : 'light';
    applyTheme(); save(true); haptic('light');
  });
  $('#setMotion').addEventListener('change', e => {
    state.motion = e.target.checked;
    applyTheme(); save(true); haptic('light');
  });
  $('#setPomoPreset').addEventListener('change', e => {
    setPomoPreset(Number(e.target.value));
  });
  $('#setPomoAuto').addEventListener('change', e => {
    state.pomo.auto = e.target.checked;
    save(true); haptic('light');
    toast(state.pomo.auto ? '结束后自动接续下一阶段' : '结束后等待手动开始');
  });
  $('#setPomoSound').addEventListener('change', e => {
    state.pomo.sound = e.target.checked;
    save(true); haptic('light');
    toast(state.pomo.sound ? '结束时响铃并震动' : '已关闭结束提示音');
  });
  $('#btnEditTemplate').addEventListener('click', () => openTemplateSheet());
  $('#btnNotifyPerm').addEventListener('click', () => {
    const n = N();
    if (n && n.requestNotificationPermission) n.requestNotificationPermission();
    else toast('请在系统设置中开启通知权限');
  });
  $('#btnExactPerm').addEventListener('click', () => {
    const n = N();
    if (n && n.openExactAlarmSettings) n.openExactAlarmSettings();
    else toast('浏览器预览中无法修改系统权限');
  });
  $('#btnUsagePerm').addEventListener('click', () => {
    const n = N();
    if (n && n.openUsageAccessSettings) n.openUsageAccessSettings();
    else toast('浏览器预览中无法修改系统权限');
  });
  $('#btnOverlayPerm').addEventListener('click', () => {
    const n = N();
    if (n && n.openOverlaySettings) n.openOverlaySettings();
    else toast('浏览器预览中无法修改系统权限');
  });
  $('#btnExport').addEventListener('click', () => {
    const snapshot = Object.assign({}, state, {
      user: state.user ? Object.assign({}, state.user, { avatarData: null }) : null
    });
    const data = JSON.stringify({ app: 'Chronos', version: 1, exportedAt: new Date().toISOString(), state: snapshot }, null, 2);
    const n = N();
    if (n && n.share) n.share(data);
    else {
      const blob = new Blob([data], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'chronos-data.json'; a.click();
    }
    toast('学习数据已准备导出');
  });
  $('#btnDemo').addEventListener('click', () => {
    seedDemo(); toast('已填充近 7 天演示数据'); renderStats(); renderHome();
  });
  $('#btnReset').addEventListener('click', () => {
    if (!confirm('确定清除全部记录吗？计划、统计和设置都会重置。')) return;
    localStorage.removeItem(STORE);
    const n = N();
    if (n && n.clearState) { try { n.clearState(); } catch (e) {} }
    state = loadState();
    applyTheme();
    toast('已清除全部记录');
    // 整页重载：既保证 UI 回到初始值，也避免 bindSettings 重复绑定（双份 toast / 双份 save）
    setTimeout(() => { try { location.reload(); } catch (e) {} }, 160);
  });

  // 开关外观
  $$('.switch input').forEach(inp => {
    const sync = () => inp.closest('.switch').classList.toggle('on', inp.checked);
    inp.addEventListener('change', sync);
    sync();
  });
}

function seedDemo() {
  const names = [
    { title: '晨间规划', subject: '工作', start: 480, end: 540, note: '梳理今日待办 · 轻量热身' },
    { title: '深度工作 1', subject: '工作', start: 540, end: 720, note: '最重要的事 · 关闭通知' },
    { title: '读书时间', subject: '阅读', start: 840, end: 1020, note: '精读 + 笔记' },
    { title: '轻量复盘', subject: '学习', start: 1140, end: 1200, note: '整理笔记 · 查漏补缺' },
    { title: '运动', subject: '运动', start: 1200, end: 1260, note: '跑步 / 力量训练' },
    { title: '自由时段', subject: '其他', start: 1260, end: 1320, note: '灵活安排 · 放松大脑' }
  ];
  const ratios = [0.94, 0.88, 0.72, 0.98, 0.62, 0.8, 0.55];
  for (let i = 6; i >= 1; i--) {
    const k = dateKey(addDays(new Date(), -i));
    if (state.days[k]) continue;
    const r = ratios[6 - i];
    const tasks = names.map((n, idx) => {
      const t = cloneTask({ ...n, id: 't' + (idx + 1), reminder: true, advance: 5, flex: true }, k);
      const fill = clamp(r + (idx % 2 ? 0.06 : -0.05), 0.35, 1);
      if (fill > 0.6) {
        t.status = 'done';
        t.focusAcc = taskDur(t) * 60 * fill;
        t.actual = t.focusAcc;
      } else if (idx === 5 && r < 0.7) {
        t.status = 'skipped';
        t.focusAcc = 0;
      } else {
        t.status = 'done';
        t.focusAcc = taskDur(t) * 60 * Math.max(fill, 0.5);
        t.actual = t.focusAcc;
      }
      return t;
    });
    state.days[k] = { tasks, createdAt: Date.now() };

    const pm = state.pomo.sessions[k] || (state.pomo.sessions[k] = []);
    const cnt = Math.max(1, Math.round(r * 5));
    for (let j = 0; j < cnt; j++) {
      const src = names[j % names.length];
      const at = parseKey(k);
      at.setHours(9 + j, 0, 0, 0);
      pm.push({
        start: at.getTime(),
        end: at.getTime() + 25 * 60000,
        minutes: 25,
        taskId: 't' + ((j % names.length) + 1),
        title: src.title
      });
    }
    state.pomo.round = (state.pomo.round || 0) + cnt;
  }
  state.demo = true;
  save(true);
}

/* ---------------- 通知 / 权限 ---------------- */
function checkPermissions() {
  const n = N();
  if (!n) {
    $('#notifyPermText').textContent = '浏览器预览模式';
    $('#btnNotifyPerm').textContent = '说明';
    $('#exactPermText').textContent = '打包为 APK 后生效';
    $('#btnExactPerm').textContent = '说明';
    $('#usagePermText').textContent = '打包为 APK 后生效';
    $('#btnUsagePerm').textContent = '说明';
    $('#overlayPermText').textContent = '打包为 APK 后生效';
    $('#btnOverlayPerm').textContent = '说明';
    $('#envHint').textContent = '当前为浏览器预览，安装 APK 后系统提醒生效';
    return;
  }
  let st = {};
  try { st = JSON.parse(n.permissionState ? n.permissionState() : '{}'); } catch (e) {}
  $('#notifyPermText').textContent = st.notify ? '已开启 · 到点会收到系统通知' : '未开启 · 提醒不会弹出';
  $('#btnNotifyPerm').textContent = st.notify ? '已开启' : '去开启';
  $('#btnNotifyPerm').classList.toggle('ok', !!st.notify);
  $('#exactPermText').textContent = st.exact ? '已允许 · 可准点提醒' : '关闭时提醒可能延迟几分钟';
  $('#btnExactPerm').textContent = st.exact ? '已允许' : '去开启';
  $('#btnExactPerm').classList.toggle('ok', !!st.exact);
  const exactRow = $('#rowExactPerm');
  if (exactRow) exactRow.hidden = !!st.exact;

  const usage = usageAccessGranted();
  $('#usagePermText').textContent = usage ? '已开启 · 极度沉浸可用' : '未开启 · 极度沉浸无法生效';
  $('#btnUsagePerm').textContent = usage ? '已开启' : '去开启';
  $('#btnUsagePerm').classList.toggle('ok', usage);

  const overlay = overlayGranted();
  $('#overlayPermText').textContent = overlay ? '已开启 · 无关应用会被盖住' : '未开启 · 切出去不会被拦截';
  $('#btnOverlayPerm').textContent = overlay ? '已开启' : '去开启';
  $('#btnOverlayPerm').classList.toggle('ok', overlay);

  if (guardPendingStart && usage && overlay) {
    guardPendingStart = false;
    syncGuard();
  }
  updateGuardRow();

  const v = n.appVersion ? n.appVersion() : '';
  if (v) $('#aboutVer').textContent = 'Version ' + v + ' · 个人版';
  $('#envHint').textContent = '数据仅保存在本机 · 不联网、不上传';
}

/* ---------------- 反馈 ---------------- */
let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1900);
}
function haptic(type) {
  const n = N();
  if (n && n.haptic) { try { n.haptic(type || 'light'); } catch (e) {} }
}

/* ---------------- 标签页 ---------------- */
let tabIndex = 0;
function switchTab(i) {
  if (i === tabIndex) return;
  tabIndex = i;
  layoutPages();
  $$('.tab').forEach((t, idx) => t.classList.toggle('is-active', idx === i));
  $('#tabIndicator').style.transform = `translateX(${i * 100}%)`;
  if (i === 1) renderFocus();
  if (i === 2) renderStats();
  if (i === 3) { checkPermissions(); bindSettingsStatic(); }
}

function layoutPages() {
  $('#pages').style.transform = `translateX(${-tabIndex * window.innerWidth}px)`;
}

function bindSettingsStatic() {
  $('#tplSummary').textContent = `${state.template.length} 个时段 · ${hText(state.template.reduce((a, t) => a + Math.max(0, t.end - t.start) * 60, 0))}`;
}

/* ---------------- 启动 ---------------- */
function boot() {
  // localStorage 失效时，从原生备份恢复
  try {
    if (!localStorage.getItem(STORE)) {
      const n = N();
      const backup = n && n.loadState ? n.loadState() : null;
      if (backup) localStorage.setItem(STORE, backup);
    }
  } catch (e) {}
  state = loadState();
  ensureToday();
  tickPomo();          // 先把"启动前就已到点"的番茄结算掉，避免带着过期 endAt 去起守护
  applyTheme();
  bindSettings();
  bindSettingsStatic();
  bindGuard();
  renderAccountUI();
  renderHome();
  renderFocus();
  renderStats();
  checkPermissions();
  layoutPages();
  consumeNative();
  syncNative();
  syncGuard();

  // 番茄钟控件
  $('#pomoMain').addEventListener('click', () => {
    haptic('light');
    if (state.pomo.running) pomoPause();
    else pomoStart();
  });
  $('#pomoReset').addEventListener('click', () => {
    haptic('light');
    pomoReset();
    toast('已重置这一轮');
  });
  $('#pomoSkip').addEventListener('click', () => {
    haptic('light');
    pomoSkip();
  });
  $('#imPause').addEventListener('click', () => {
    haptic('light');
    if (state.pomo.running) pomoPause(); else pomoStart();
  });
  $('#imExit').addEventListener('click', () => {
    haptic('light');
    closeImmerse();
    renderFocus();
  });
  $$('#pomoPresets button').forEach(b => {
    b.addEventListener('click', () => setPomoPreset(Number(b.dataset.preset)));
  });

  // 统计区间切换
  $$('#rangeSeg button').forEach(b => {
    b.addEventListener('click', () => {
      if (statsRange === Number(b.dataset.range)) return;
      statsRange = Number(b.dataset.range);
      $$('#rangeSeg button').forEach(x => x.classList.toggle('on', x === b));
      haptic('light');
      moveGlider($('#rangeSeg'), $('#rangeGlider'), b);
      renderStats();
    });
  });
  moveGlider($('#rangeSeg'), $('#rangeGlider'), $('#rangeSeg button.on'));

  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => { haptic('light'); switchTab(Number(tab.dataset.tab)); });
  });
  $('#editPlanBtn').addEventListener('click', () => { haptic('light'); openPlanSheet(); });
  $('#sheetBackdrop').addEventListener('click', () => { haptic('light'); closeSheet(); });
  bindDetailCards();

  $$('.scroll').forEach(sc => {
    sc.addEventListener('scroll', () => {
      const y = sc.scrollTop;
      $('#ambient').style.transform = `translate3d(0, ${-y * 0.05}px, 0)`;
    }, { passive: true });
  });

  window.addEventListener('resize', () => {
    layoutPages();
    moveGlider($('#pomoPresets'), $('#pomoPresetGlider'), $('#pomoPresets button.on'));
    moveGlider($('#rangeSeg'), $('#rangeGlider'), $('#rangeSeg button.on'));
  });
  window.addEventListener('orientationchange', () => setTimeout(layoutPages, 250));

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      ensureToday();
      tickPomo();
      renderHome();
      renderStats();
      checkPermissions();
      consumeNative();
      syncGuard();
    }
  });

  window.__onNativeResume = () => {
    ensureToday();
    tickPomo();
    renderHome();
    checkPermissions();
    consumeNative();
    syncGuard();
  };
  window.__openTask = id => {
    const rec = todayRec();
    const t = rec && rec.tasks.find(x => x.id === id);
    switchTab(0);
    if (t) setTimeout(() => openTaskSheet(t), 200);
  };

  // 每秒刷新时钟与计时
  setInterval(() => {
    updateClocks();
    tickPomo();
    const rec = todayRec();
    if (!rec) return;
    const info = currentInfo(rec);
    const t = info.task;
    const heroTimer = $('#heroTimer');
    if (heroTimer && t) {
      if (t.focusStart) heroTimer.textContent = clockStr(taskSeconds(t));
    }
    const focusTime = $('#focusTime');
    if (focusTime && sheetTaskId) {
      const st = rec.tasks.find(x => x.id === sheetTaskId);
      if (st && st.focusStart) {
        focusTime.textContent = clockStr(taskSeconds(st));
        const sa = $('#sheetActual');
        if (sa) sa.textContent = Math.round(taskSeconds(st) / 60) + ' 分钟';
      }
    }
  }, 1000);

  // 每 15 秒检查跨时段 / 跨天
  let lastSig = '';
  let dayCursor = todayKey();
  setInterval(() => {
    const rec = todayRec();
    if (!rec) return;
    const info = currentInfo(rec);
    const sig = info.mode + ':' + (info.task ? info.task.id : '') + ':' + rec.tasks.filter(t => t.status === 'done').length;
    if (sig !== lastSig) {
      lastSig = sig;
      if (!sheetOpen) { renderHome(); }
    } else if (!sheetOpen) {
      const el = $('#nowCard');
      if (el && el.dataset.sig && el.dataset.sig.indexOf('active') === 0 && !(info.task && info.task.focusStart)) {
        renderNow();
      }
    }
    if (todayKey() !== dayCursor) {
      dayCursor = todayKey();
      ensureToday();
      renderHome();
      renderStats();
    }
  }, 15000);
}

document.addEventListener('DOMContentLoaded', boot);

// 原生注入的安全区
window.__applyInsets = (top, bottom, ime) => {
  const root = document.documentElement;
  root.style.setProperty('--sat', (top || 0) + 'px');
  root.style.setProperty('--sab', (bottom || 0) + 'px');
  root.style.setProperty('--kb', (ime || 0) + 'px');
  document.body.classList.toggle('kb-open', (ime || 0) > 60);
};
