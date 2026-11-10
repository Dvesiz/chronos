// Regression: stats page layout semantics.
//
// 1. The check-in calendar is a BY-MONTH view and must not sit under the
//    7/30-day range switch as if it were part of that period.
// 2. Period cards carry .period-card so the range switch only flashes them.
// 3. The calendar is collapsible on phones (keeps the page short) but expands
//    on wide screens, with CSS and JS agreeing on the same breakpoint.
// 4. The overview numbers are the visual anchor of the page.
//
// NOTE: the stats grid is intentionally FLAT. An earlier attempt nested the
// period cards in a .stats-period wrapper; at the 6-column breakpoint it only
// spanned 2 columns and squashed everything into the left third. Keep it flat.
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
const heroIdx = idx('id="statHero"');
const barsIdx = idx('data-detail="daily"');
const catIdx = idx('data-detail="category"');
const reportIdx = idx('id="reportCard"');
const calIdx = idx('id="calendarCard"');
const labelIdx = idx('stats-section-label');

assert.ok(heroIdx > -1 && barsIdx > -1 && catIdx > -1 && reportIdx > -1, '周期卡片应存在');
assert.ok(calIdx > -1, '日历卡片应存在');
assert.ok(calIdx > heroIdx, '日历不应排在周期概览之前');
assert.ok(calIdx > barsIdx, '日历不应排在每日投入之前');
assert.ok(calIdx > reportIdx, '日历应排在期间总结之后');

// --- 2. no nested period wrapper (the bug that squashed the page) ----------
assert.ok(!/id="statsPeriod"/.test(html), '不应再使用 #statsPeriod 嵌套容器');
assert.ok(!/class="stats-period"/.test(html), '不应再使用 .stats-period 容器');
assert.ok(!/\.stats-period\b/.test(css), 'CSS 不应残留 .stats-period 规则');
// 周期卡片用独立 class，便于区间切换时只闪这些卡
['statHero', 'goalCard', 'reportCard'].forEach(id => {
  const at = idx(`id="${id}"`);
  assert.ok(at > -1, `${id} 应存在`);
  const tagEnd = grid.indexOf('>', at);
  const tagStart = grid.lastIndexOf('<', at);
  const tag = grid.slice(tagStart, tagEnd);
  assert.ok(/period-card/.test(tag), `${id} 应带 .period-card 标记`);
});

// --- 3. calendar is not the first grid child -------------------------------
const afterOpen = grid.slice(grid.indexOf('>') + 1)
  .replace(/<!--[\s\S]*?-->/g, '')
  .trimStart();
assert.ok(!afterOpen.startsWith('<div class="chart-card glass calendar-card"'),
  '日历不应是统计格子的第一个元素');
assert.ok(afterOpen.startsWith('<div class="stat-hero'),
  '统计格子首元素应为概览卡');

// --- 4. by-month group has its own label and does not claim the range ------
assert.ok(labelIdx > -1 && labelIdx < calIdx, '日历前应有「按月」分组标题');
const labelBlock = grid.slice(labelIdx, calIdx);
assert.ok(/按月/.test(labelBlock), '分组标题应包含「按月」');
assert.ok(/不受上方/.test(labelBlock), '分组说明应写明不受上方区间影响');
assert.ok(/monthToggle/.test(labelBlock), '按月回顾应提供折叠开关');
assert.ok(/aria-expanded/.test(labelBlock), '折叠开关应有 aria-expanded 状态');

// --- 5. collapsed on phones, expanded on wide screens, same breakpoint -----
assert.ok(/calendar-card\.is-collapsed\s*\{\s*display:\s*none/.test(css), '折叠时应隐藏日历');

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
const wideHeader = '@media (min-width: 760px) and (min-height: 600px)';
const wideBlock = mediaBlock(css, wideHeader);
assert.ok(wideBlock.length > 0, `应有 ${wideHeader} 媒体查询`);
assert.ok(/calendar-card\.is-collapsed\s*\{\s*display:\s*block/.test(wideBlock),
  '平板/大屏应强制展开日历');

const jsWide = /matchMedia\('\(min-width:\s*(\d+)px\)'\)/.exec(js);
assert.ok(jsWide, 'JS 应通过 matchMedia 判断宽屏');
assert.equal(jsWide[1], '760', 'JS 宽屏阈值应与 CSS 媒体查询一致（760px）');

// --- 6. range switch only flashes period cards -----------------------------
assert.ok(/function flashStatsPeriod/.test(js), '应有周期段切换反馈');
assert.ok(/querySelectorAll\('\.period-card'\)/.test(js), '切换反馈应针对 .period-card');
assert.ok(/\.period-card\.is-period-flash/.test(css), '周期卡片应有高亮样式');
assert.ok(!/\.stat-hero\.tap-card::after[^{]*\{[^}]*right:/.test(css),
  '概览卡不应再有右下角详情箭头（4 列平铺后会落在空格里）');

// --- 7. overview numbers are the visual anchor -----------------------------
assert.ok(/\.stat-hero \.stat-block \.v\s*\{[\s\S]{0,200}?font-size:\s*40px/.test(css),
  '概览数字应显著放大，成为视觉重心');

console.log('✓ 统计页：扁平栅格、日历归入按月回顾、周期卡隔离、手机可折叠、概览为视觉重心');
