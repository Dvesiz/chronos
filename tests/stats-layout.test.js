// Regression: stats page layout semantics.
//
// 1. The check-in calendar is a BY-MONTH view and must not sit under the
//    7/30-day range switch as if it were part of that period.
// 2. Period cards live inside #statsPeriod so the range switch only affects them.
// 3. The calendar is collapsible on phones (keeps the page short) but expands
//    on wide screens.
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('app/src/main/assets/www/index.html', 'utf8');
const css = fs.readFileSync('app/src/main/assets/www/styles.css', 'utf8');
const js = fs.readFileSync('app/src/main/assets/www/app.js', 'utf8');

const gridStart = html.indexOf('<div class="stats-grid">');
assert.ok(gridStart > -1, '统计页应有 stats-grid 容器');
const settingsStart = html.indexOf('id="pageSettings"', gridStart);
const grid = html.slice(gridStart, settingsStart > -1 ? settingsStart : html.length);

const idx = needle => grid.indexOf(needle);

// --- 1. calendar comes after every period card -----------------------------
const periodStart = idx('id="statsPeriod"');
const periodEnd = idx('id="calendarCard"');
const barsIdx = idx('data-detail="daily"');
const catIdx = idx('data-detail="category"');
const reportIdx = idx('id="reportCard"');
const calIdx = idx('id="calendarCard"');
const labelIdx = idx('stats-section-label');

assert.ok(periodStart > -1, '应有周期段容器 #statsPeriod');
assert.ok(barsIdx > -1 && catIdx > -1 && reportIdx > -1, '周期卡片应存在');
assert.ok(calIdx > -1, '日历卡片应存在');

// 周期卡片必须在周期段容器内部（在 calendarCard 之前）
assert.ok(barsIdx > periodStart, '每日投入应在周期段内');
assert.ok(catIdx > periodStart, '分类分布应在周期段内');
assert.ok(reportIdx > periodStart, '期间总结应在周期段内');
// 日历在周期段之后
assert.ok(calIdx > reportIdx, '日历应排在期间总结之后');

// --- 2. calendar is not the first grid child -------------------------------
const afterOpen = grid.slice(grid.indexOf('>') + 1)
  .replace(/<!--[\s\S]*?-->/g, '')   // 跳过注释，只看真实元素
  .trimStart();
assert.ok(!afterOpen.startsWith('<div class="chart-card glass calendar-card"'),
  '日历不应是统计格子的第一个元素');
assert.ok(afterOpen.startsWith('<div class="stats-period"'),
  '统计格子首元素应为周期段容器 #statsPeriod');

// --- 3. by-month group has its own label and does not claim the range ------
assert.ok(labelIdx > -1 && labelIdx < calIdx, '日历前应有「按月」分组标题');
const labelBlock = grid.slice(labelIdx, calIdx);
assert.ok(/按月/.test(labelBlock), '分组标题应包含「按月」');
assert.ok(/不受上方/.test(labelBlock), '分组说明应写明不受上方区间影响');
assert.ok(/monthToggle/.test(labelBlock), '按月回顾应提供折叠开关');
assert.ok(/aria-expanded/.test(labelBlock), '折叠开关应有 aria-expanded 状态');

// --- 4. collapsed by default on phones, expanded on wide screens -----------
assert.ok(/calendar-card\.is-collapsed\s*\{\s*display:\s*none/.test(css),
  '折叠时应隐藏日历');

// 找到 min-width:900px 媒体查询块，确认其中把日历改回 display:block
function mediaBlock(source, header) {
  const at = source.indexOf(header);
  if (at < 0) return '';
  let depth = 0, started = false;
  for (let i = at + header.length; i < source.length; i++) {
    if (source[i] === '{') { depth++; started = true; }
    else if (source[i] === '}') {
      depth--;
      if (started && depth === 0) return source.slice(at, i + 1);
    }
  }
  return '';
}
const wideBlock = mediaBlock(css, '@media (min-width: 760px) and (min-height: 600px)');
assert.ok(wideBlock.length > 0, '应有 min-width:760px 媒体查询');
assert.ok(/calendar-card\.is-collapsed\s*\{\s*display:\s*block/.test(wideBlock),
  '平板/大屏应强制展开日历');

// CSS 展开阈值必须与 JS 判断一致，否则会出现「CSS 显示但 JS 认为收起」的错位
const jsWide = /matchMedia\('\(min-width:\s*(\d+)px\)'\)/.exec(js);
assert.ok(jsWide, 'JS 应通过 matchMedia 判断宽屏');
assert.equal(jsWide[1], '760', 'JS 宽屏阈值应与 CSS 媒体查询一致（760px）');

// --- 5. range switch only flashes the period block -------------------------
assert.ok(/function flashStatsPeriod/.test(js), '应有周期段切换反馈');
assert.ok(/\$\('#statsPeriod'\)/.test(js), '切换反馈应针对 #statsPeriod');
assert.ok(/is-period-flash/.test(css), '周期段应有高亮样式');

// --- 6. overview numbers are the visual anchor -----------------------------
assert.ok(/\.stat-hero \.stat-block \.v\s*\{[\s\S]{0,200}?font-size:\s*40px/.test(css),
  '概览数字应显著放大，成为视觉重心');

console.log('✓ 统计页：日历归入按月回顾、周期段隔离、手机可折叠、概览为视觉重心');
