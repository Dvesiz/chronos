import asyncio
import os
import tempfile
from playwright.async_api import async_playwright

URL = "http://127.0.0.1:8899/index.html"
OUT = os.environ.get("CHRONOS_E2E_OUT", os.path.join(tempfile.gettempdir(), "chronos-e2e"))
os.makedirs(OUT, exist_ok=True)

# 模拟服务端：内存里维护云端状态与 head_seq
SERVER = r"""
window.__fake = {
  state: { days: {}, reviews: {}, template: [] },
  headSeq: 0,
  calls: [],
  rejectReplace: true
};
window.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts.body ? JSON.parse(opts.body) : {};
  window.__fake.calls.push(u.replace('https://api.example', ''));
  const json = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

  if (u.includes('/v1/auth/verify')) return json({ accessToken: 'a', refreshToken: 'r', user: { email: 'u@e.com' } });
  if (u.includes('/v1/sync/snapshot')) return json({ state: JSON.parse(JSON.stringify(window.__fake.state)), headSeq: window.__fake.headSeq });
  if (u.includes('/v1/sync/head')) return json({ headSeq: window.__fake.headSeq });
  if (u.includes('/v1/sync/events')) {
    const events = body.events || [];
    let accepted = [];
    for (const ev of events) {
      const ops = ev.ops || [];
      const fullReplace = ops.some(o => o.op === 'replace' && (!o.path || o.path.length === 0));
      // 服务端守卫：云端已有数据时拒绝整份覆盖
      if (fullReplace && window.__fake.headSeq > 0 && window.__fake.rejectReplace) {
        return json({ error: 'replace_forbidden', message: '云端已有数据，不允许整份覆盖' }, 409);
      }
      // 简化 apply
      for (const op of ops) {
        if (op.op === 'replace' && (!op.path || op.path.length === 0)) window.__fake.state = JSON.parse(JSON.stringify(op.value));
        else if (op.op === 'set' && op.path && op.path.length) {
          let cur = window.__fake.state;
          for (let i = 0; i < op.path.length - 1; i++) { cur[op.path[i]] = cur[op.path[i]] || {}; cur = cur[op.path[i]]; }
          cur[op.path[op.path.length - 1]] = JSON.parse(JSON.stringify(op.value));
        }
      }
      window.__fake.headSeq++;
      accepted.push({ eventId: ev.eventId, serverSeq: window.__fake.headSeq });
    }
    return json({ ok: true, headSeq: window.__fake.headSeq, accepted, state: JSON.parse(JSON.stringify(window.__fake.state)) });
  }
  return json({ error: 'not_found' }, 404);
};
"""

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()

        # ---- 设备 A（安卓）：写入新数据并上传 ----
        a = await b.new_page(viewport={"width": 1280, "height": 900})
        await a.add_init_script("try{localStorage.setItem('chronos.web.demo-seen.v1','1')}catch(e){}")
        await a.goto(URL, wait_until="networkidle", timeout=60000)
        await a.evaluate(SERVER)
        await a.evaluate("""() => {
          document.querySelectorAll('.web-welcome').forEach(e => e.remove());
          localStorage.setItem('chronos.state.v1', JSON.stringify({
            theme:'light', motion:true, remind:true, advance:5,
            template:[], reviews:{}, milestones:{}, celebrated:{},
            days: { '2026-11-13': { tasks: [{ id: 'android-1', title: '安卓新记录', subject:'工作', start:540, end:660, status:'done', focusAcc:3600, pomoAcc:0, focusStart:null }], createdAt: Date.now() } },
            pomo:{ preset:25, auto:false, sound:true, sessions:{}, phase:'focus', remain:1500, running:false, endAt:null, round:0, guard:false, taskId:null, taskTitle:'', sessionStartAt:null }
          }));
        }""")
        await a.reload(wait_until="networkidle")
        await a.evaluate(SERVER)
        await a.evaluate("document.querySelectorAll('.web-welcome').forEach(e => e.remove())")
        await a.evaluate("ChronosCloud.init({ get: () => state, apply: s => { state = s; save(true); } })")
        await a.evaluate("ChronosCloud.verify('u@e.com','123456')")
        await a.wait_for_timeout(1500)
        cloud_after_a = await a.evaluate("JSON.parse(JSON.stringify(window.__fake.state))")
        heads = await a.evaluate("window.__fake.headSeq")
        print("A uploaded -> headSeq:", heads, "| cloud days:", list(cloud_after_a.get('days', {}).keys()))

        # ---- 设备 B（浏览器）：本地是几小时前的旧数据，登录 ----
        bb = await b.new_page(viewport={"width": 1280, "height": 900})
        await bb.add_init_script("try{localStorage.setItem('chronos.web.demo-seen.v1','1')}catch(e){}")
        await bb.goto(URL, wait_until="networkidle", timeout=60000)
        await bb.evaluate(SERVER)
        # 关键：把 A 已经写进云端的状态灌进 B 的 fake server
        await bb.evaluate("(s) => { window.__fake.state = s; window.__fake.headSeq = %d; }" % heads, cloud_after_a)
        await bb.evaluate("""() => {
          document.querySelectorAll('.web-welcome').forEach(e => e.remove());
          // 浏览器本地是很久以前的旧数据
          localStorage.setItem('chronos.state.v1', JSON.stringify({
            theme:'light', motion:true, remind:true, advance:5,
            template:[], reviews:{}, milestones:{}, celebrated:{},
            days: { '2026-11-01': { tasks: [{ id:'browser-old', title:'浏览器旧记录', subject:'学习', start:540, end:600, status:'done', focusAcc:600, pomoAcc:0, focusStart:null }], createdAt: Date.now() } },
            pomo:{ preset:25, auto:false, sound:true, sessions:{}, phase:'focus', remain:1500, running:false, endAt:null, round:0, guard:false, taskId:null, taskTitle:'', sessionStartAt:null }
          }));
        }""")
        await bb.reload(wait_until="networkidle")
        await bb.evaluate(SERVER)
        await bb.evaluate("(s) => { window.__fake.state = s; window.__fake.headSeq = %d; }" % heads, cloud_after_a)
        await bb.evaluate("document.querySelectorAll('.web-welcome').forEach(e => e.remove())")
        await bb.evaluate("ChronosCloud.init({ get: () => state, apply: s => { state = s; save(true); } })")
        await bb.evaluate("ChronosCloud.verify('u@e.com','123456')")
        await bb.wait_for_timeout(2000)

        cloud_after_b = await bb.evaluate("JSON.parse(JSON.stringify(window.__fake.state))")
        b_days = await bb.evaluate("Object.keys(state.days)")
        b_android_task = await bb.evaluate("!!(state.days['2026-11-13'] && state.days['2026-11-13'].tasks.find(t => t.id === 'android-1'))")
        print("B cloud days:", list(cloud_after_b.get('days', {}).keys()))
        print("B local days:", b_days)
        print("B sees android-1:", b_android_task)
        assert b_android_task, "browser login must retain the Android record"
        assert "2026-11-01" not in cloud_after_b.get("days", {}), "browser stale data must not overwrite cloud"
        await bb.screenshot(path=f"{OUT}/sync-login-browser.png")

        await a.close()
        await bb.close()
        await b.close()

asyncio.run(main())
