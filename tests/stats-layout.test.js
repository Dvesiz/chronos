// Regression: the check-in calendar is a by-month view. It must NOT sit at the
// top of the stats grid where the 7/30-day range switch visually claims it.
// It should appear after the period-based cards, under its own "按月回顾" label.
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('app/src/main/assets/www/index.html', 'utf8');

const gridStart = html.indexOf('<div class="stats-grid">');
assert.ok(gridStart > -1, '统计页应有 stats-grid 容器');
// 页面里 goalCard 是 <section>，按 </section> 截断会切掉后面的卡片，
// 所以直接取到下一个页面级标记（设置页）之前。
const settingsStart = html.indexOf('id="pageSettings"', gridStart);
const grid = html.slice(gridStart, settingsStart > -1 ? settingsStart : html.length);

const idx = needle => grid.indexOf(needle);

const heroIdx = idx('id="statHero"');
const barsIdx = idx('data-detail="daily"');
const catIdx = idx('data-detail="category"');
const reportIdx = idx('id="reportCard"');
const calIdx = idx('id="calendarCard"');
const labelIdx = idx('stats-section-label');

assert.ok(heroIdx > -1 && barsIdx > -1 && catIdx > -1 && reportIdx > -1 && calIdx > -1,
  '周期概览与日历卡片都应存在');

// 日历必须在所有「按周期」卡片之后
assert.ok(calIdx > heroIdx, '日历不应排在周期概览之前');
assert.ok(calIdx > barsIdx, '日历不应排在每日投入之前');
assert.ok(calIdx > reportIdx, '日历应排在周期总结之后');

// 日历前必须有独立的分组标题，说明它是按月视图
assert.ok(labelIdx > -1, '日历前应有分组标题');
assert.ok(labelIdx < calIdx, '分组标题应在日历之前');
assert.ok(labelIdx > reportIdx, '分组标题应在周期卡片之后');

// 分组标题需要明确说明不受 7/30 天影响
const labelBlock = grid.slice(labelIdx, calIdx);
assert.ok(/按月/.test(labelBlock), '分组标题应包含「按月」');
assert.ok(/不受上方/.test(labelBlock), '分组说明应写明不受上方区间影响');

// 日历不能是 stats-grid 的第一个子元素（这正是之前的排版错误）
const firstChild = grid.slice(grid.indexOf('>') + 1).trimStart();
assert.ok(!firstChild.startsWith('<div class="chart-card glass calendar-card"'),
  '日历不应是统计格子的第一个元素');

console.log('✓ 打卡日历归入「按月回顾」分组，不再被 7/30 天区间误领');
