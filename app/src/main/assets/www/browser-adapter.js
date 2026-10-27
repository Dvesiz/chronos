/* Chronos browser demo adapter: the APK keeps using Native; Pages gets a small welcome/demo layer. */
(function () {
  'use strict';
  if (window.Native) return;
  const DEMO_SEEN = 'chronos.web.demo-seen.v1';
  const $ = (s, r = document) => r.querySelector(s);

  function browserDemoState() {
    return {
      theme: 'light', motion: true, remind: true, advance: 5,
      template: [
        { id: 't1', title: '晨间规划', subject: '工作', start: 480, end: 540, note: '梳理今日待办 · 轻量热身', reminder: true, advance: 5, flex: true },
        { id: 't2', title: '深度工作', subject: '工作', start: 540, end: 720, note: '最重要的事 · 关闭通知', reminder: true, advance: 5, flex: true },
        { id: 't3', title: '读书时间', subject: '阅读', start: 840, end: 1020, note: '精读 + 笔记', reminder: true, advance: 5, flex: true },
        { id: 't4', title: '运动', subject: '运动', start: 1200, end: 1260, note: '跑步 / 力量训练', reminder: true, advance: 5, flex: true }
      ],
      days: {}, reviews: {}, milestones: {}, celebrated: {},
      exam: { date: '2026-12-26', label: '考研' }, goalWeekly: 20,
      pomo: { preset: 25, auto: false, sound: true, sessions: {}, phase: 'focus', remain: 1500, running: false, endAt: null, round: 0, guard: false }
    };
  }

  function showWelcome() {
    if (localStorage.getItem(DEMO_SEEN)) return;
    const layer = document.createElement('div');
    layer.className = 'web-welcome';
    layer.innerHTML = `
      <div class="web-welcome-card">
        <div class="web-welcome-kicker">CHRONOS · WEB DEMO</div>
        <h2>先体验一下时序</h2>
        <p>这是 APK 的浏览器体验版。计划、计时、番茄钟、统计和打卡都在本地运行，数据只保存在当前浏览器。</p>
        <div class="web-welcome-actions">
          <button class="btn btn-primary" id="webDemoStart">加载体验数据</button>
          <button class="btn btn-ghost" id="webDemoEmpty">从空白开始</button>
        </div>
        <div class="web-welcome-note">Android 专属提醒、悬浮窗和极度沉浸功能需安装 APK。</div>
      </div>`;
    document.body.appendChild(layer);
    $('#webDemoStart', layer).addEventListener('click', () => {
      localStorage.setItem('chronos.web.demo-seed.v1', JSON.stringify(browserDemoState()));
      localStorage.setItem(DEMO_SEEN, '1');
      location.reload();
    });
    $('#webDemoEmpty', layer).addEventListener('click', () => {
      localStorage.setItem(DEMO_SEEN, '1');
      layer.remove();
    });
  }

  function seedBrowserDemo() {
    const demo = localStorage.getItem('chronos.web.demo-seed.v1');
    if (!demo || localStorage.getItem('chronos.state.v1')) return;
    try { localStorage.setItem('chronos.state.v1', demo); } catch (e) {}
  }

  seedBrowserDemo();
  window.addEventListener('load', () => setTimeout(showWelcome, 180));
})();
