// P1 优化回归测试。
//
// P1-2 diff 性能：旧实现每层递归都 JSON.stringify 整个子树，days 涨到 120 天后
//      一次 save 会重复序列化几十次。现在改为结构比较（sameValue），
//      行为必须完全等价（产出相同的 ops）。
//
// P1-3 字段级合并：两台设备改同一天 tasks 里的不同任务时，旧实现整块覆盖，
//      后到的会抹掉先到的另一项改动。现在服务端按元素 id 合并。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const CLIENT = fs.readFileSync('app/src/main/assets/www/cloud-sync.js', 'utf8');
const CORE = fs.readFileSync('backend/src/core.js', 'utf8');

function loadClient() {
  const values = new Map();
  const intervals = [];
  const localStorage = {
    getItem: k => (values.has(k) ? values.get(k) : null),
    setItem: (k, v) => values.set(k, String(v)),
    removeItem: k => values.delete(k)
  };
  const window = {
    CHRONOS_API_BASE: '',
    localStorage,
    AbortController,
    crypto: { randomUUID: () => 'e' },
    confirm: () => true,
    addEventListener: () => {},
    setInterval: (cb, ms) => { intervals.push(ms); return 1; },
    setTimeout, clearTimeout
  };
  const document = { hidden: false, addEventListener: () => {} };
  vm.runInNewContext(CLIENT, {
    window, document, localStorage, fetch: async () => { throw new Error('no net'); },
    AbortController, crypto: window.crypto, setTimeout, clearTimeout, console,
    setInterval: window.setInterval, clearInterval: () => {}
  });
  return window.ChronosCloud;
}

(async () => {
  // ---------- P1-2：diff 行为等价 ----------
  {
    const api = loadClient();
    // 通过 queueState 间接验证 diff：只改一个字段，应只产出该字段的 op
    let state = { days: { '2026-11-13': { tasks: [{ id: 'a', n: 1 }] } }, theme: 'light' };
    const harness = (() => {
      const values = new Map();
      const localStorage = {
        getItem: k => (values.has(k) ? values.get(k) : null),
        setItem: (k, v) => values.set(k, String(v)),
        removeItem: k => values.delete(k)
      };
      values.set('chronos.cloud.session.v1', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }));
      const window = {
        CHRONOS_API_BASE: 'https://api.example', localStorage, AbortController,
        crypto: { randomUUID: () => 'e' + Math.random() },
        confirm: () => true, addEventListener: () => {},
        setInterval: () => 1, setTimeout, clearTimeout
      };
      const document = { hidden: false, addEventListener: () => {} };
      vm.runInNewContext(CLIENT, {
        window, document, localStorage,
        fetch: async () => ({ ok: false, status: 503, json: async () => ({ error: 'offline' }) }),
        AbortController, crypto: window.crypto, setTimeout, clearTimeout, console,
        setInterval: window.setInterval, clearInterval: () => {}
      });
      return { api: window.ChronosCloud, values };
    })();

    harness.api.init({ get: () => state, apply: s => { state = s; } });
    await new Promise(r => setImmediate(r));

    // 只改 theme
    state = { days: { '2026-11-13': { tasks: [{ id: 'a', n: 1 }] } }, theme: 'dark' };
    harness.api.queueState(state);
    const queued = JSON.parse(harness.values.get('chronos.cloud.queue.v1') || '[]');
    assert.ok(queued.length >= 1, '应有事件入队');
    const lastOps = queued[queued.length - 1].ops;
    assert.ok(lastOps.length === 1 && lastOps[0].path.join('.') === 'theme',
      `只改 theme 应只产出 theme 一条 op，实际 ${JSON.stringify(lastOps.map(o => o.path.join('.')))}`);
    console.log('✓ P1-2 diff：结构比较与旧实现行为等价（只产出变化字段）');
  }

  // ---------- P1-3：不同 id 的元素互不覆盖 ----------
  {
    const mod = await import('../backend/src/core.js');
    const { applyOps } = mod;

    // 设备 A 只提交它改过的那一条（客户端 diff 会带上整个数组）
    let state = {
      days: {
        '2026-11-13': {
          tasks: [
            { id: 'task-1', title: '数学', status: 'todo' },
            { id: 'task-2', title: '英语', status: 'todo' }
          ]
        }
      }
    };
    state = applyOps(state, [{
      op: 'set', path: ['days', '2026-11-13', 'tasks'],
      value: [
        { id: 'task-1', title: '数学', status: 'done' },
        { id: 'task-2', title: '英语', status: 'todo' }
      ]
    }]);

    // 设备 B 新增了一条任务，只提交了 task-3（A 的 task-1 不在它的提交里）
    state = applyOps(state, [{
      op: 'set', path: ['days', '2026-11-13', 'tasks'],
      value: [{ id: 'task-3', title: '政治', status: 'todo' }]
    }]);

    const tasks = state.days['2026-11-13'].tasks;
    assert.equal(tasks.length, 3, 'B 新增任务不应抹掉 A 已有的任务');
    assert.ok(tasks.find(t => t.id === 'task-1').status === 'done', 'task-1 应保留完成状态');
    assert.ok(tasks.find(t => t.id === 'task-3'), 'task-3 应被加入');
    console.log('✓ P1-3 字段级合并：不同 id 的元素互不覆盖，新增不丢旧数据');
  }

  // ---------- P1-3 已知取舍：同 id 并发修改仍按后到覆盖 ----------
  {
    const mod = await import('../backend/src/core.js');
    const { applyOps } = mod;
    let state = { days: { d: { tasks: [{ id: 't1', status: 'done' }, { id: 't2', status: 'todo' }] } } };
    // 设备 B 用旧快照整数组覆盖，同 id 的 t1 会被写回 todo
    state = applyOps(state, [{
      op: 'set', path: ['days', 'd', 'tasks'],
      value: [{ id: 't1', status: 'todo' }, { id: 't2', status: 'todo' }]
    }]);
    assert.equal(state.days.d.tasks.find(t => t.id === 't1').status, 'todo',
      '同 id 的并发修改没有逐元素时间戳，只能按后到覆盖（已知取舍）');
    console.log('✓ P1-3 已知取舍：同 id 并发修改仍为后到覆盖（缺逐元素时间戳）');
  }

  // ---------- P1-3 兜底：无 id 的数组退回整块替换 ----------
  {
    const mod = await import('../backend/src/core.js');
    const { applyOps } = mod;
    let state = { days: { d: { partialFocus: [{ start: 1, seconds: 10 }, { start: 2, seconds: 20 }] } } };
    state = applyOps(state, [{ op: 'set', path: ['days', 'd', 'partialFocus'], value: [{ start: 9, seconds: 99 }] }]);
    assert.equal(state.days.d.partialFocus.length, 1, '无 id 的数组应整块替换，不做错误合并');
    console.log('✓ P1-3 兜底：无 id 数组退回整块替换，不误合并');
  }

  console.log('\n全部通过：diff 行为等价 + 字段级合并生效');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
