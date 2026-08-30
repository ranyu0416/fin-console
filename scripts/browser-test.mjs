#!/usr/bin/env node
/**
 * 浏览器端自检：用本机的无头 Edge/Chrome 通过 CDP 真正打开页面，
 * 走一遍 登录 → 加载台账 → 切模块 → 新增记录 → 结账只读 → 打印数据组装，
 * 并断言全程没有 JS 报错。
 *   node scripts/browser-test.mjs
 * 缺少运行条件时以退出码 3 表示跳过，由 test:all 明确报告而不伪装成通过。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Node 22+ 自带全局 WebSocket，用它连 CDP，无需任何第三方库
if (typeof WebSocket === 'undefined') {
  console.log('[browser] SKIPPED: 当前 Node 没有全局 WebSocket（需 Node 22+）');
  process.exit(3);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(HERE, '..');

const BROWSERS = [
  process.env.FIN_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const browserPath = BROWSERS.find((p) => existsSync(p));
if (!browserPath) {
  console.log('[browser] SKIPPED: 未找到 Edge/Chrome');
  process.exit(3);
}

const PORT = 19200 + Math.floor(Math.random() * 300);
const CDP_PORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { username: 'admin', password: 'Browser12345' };
const DATA_DIR = mkdtempSync(join(tmpdir(), 'fin-browser-'));
const PROFILE_DIR = mkdtempSync(join(tmpdir(), 'fin-profile-'));

let passed = 0;
const failures = [];
function ok(n) { passed += 1; console.log(`  ✓ ${n}`); }
function bad(n, d) { failures.push(`${n}：${d}`); console.log(`  ✗ ${n} — ${d}`); }
async function check(name, fn) {
  try { await fn(); ok(name); } catch (e) { bad(name, e.message); }
}
function assert(c, m) { if (!c) throw new Error(m); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 启动服务与浏览器 ---------- */
const server = spawn(process.execPath, ['server.js'], {
  cwd: SERVER_ROOT,
  env: {
    ...process.env,
    FIN_HOST: '127.0.0.1',
    FIN_PORT: String(PORT),
    FIN_DATA_DIR: DATA_DIR,
    FIN_ADMIN_USER: ADMIN.username,
    FIN_ADMIN_PASSWORD: ADMIN.password,
    FIN_BACKUP_INTERVAL_HOURS: '0',
    FIN_ORG_NAME: '浏览器自检公司',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

const browser = spawn(
  browserPath,
  [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--window-size=1440,900',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'ignore'] },
);

function cleanup() {
  for (const p of [browser, server]) { try { p.kill(); } catch { /* 已退出 */ } }
  setTimeout(() => {
    for (const d of [DATA_DIR, PROFILE_DIR]) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* 交给系统清理 */ }
    }
  }, 400);
}

async function waitFor(url, label, timeoutMs = 25000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json().catch(() => ({}));
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  throw new Error(`${label} 在 ${timeoutMs}ms 内未就绪`);
}

/* ---------- 极简 CDP 客户端 ---------- */
class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  ready() {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === 1) return resolve();
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP ${method} 超时`));
        }
      }, 30000);
    });
  }
  async eval(expression) {
    const out = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (out.exceptionDetails) {
      throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text);
    }
    return out.result.value;
  }
  close() { try { this.ws.close(); } catch { /* 已关闭 */ } }
}

/** 浏览器级 WebSocket 不支持 Runtime 域，必须连到具体的 page target */
async function findPageTarget(timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* 还没就绪 */ }
    await sleep(250);
  }
  throw new Error('未找到可调试的页面目标');
}

let cdp = null;
/* facility 结账落在哪个期间（= 账套期间）由上一步测出来，后面几步共用 */
let closedYm = '';
try {
  await waitFor(`${BASE}/api/health`, '服务器');
  await waitFor(`http://127.0.0.1:${CDP_PORT}/json/version`, '浏览器调试端口');
  const target = await findPageTarget();

  cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');

  console.log('\n页面启动：');
  await check('页面能打开并显示登录层', async () => {
    await cdp.send('Page.navigate', { url: BASE + '/' });
    await sleep(1500);
    const state = await cdp.eval(`
      return {
        title: document.title,
        authShown: document.getElementById('authOverlay').classList.contains('show'),
        shellHidden: document.getElementById('appShell').style.display === 'none',
        hasLogin: !!document.getElementById('loginUser')
      };
    `);
    assert(state.title === '财务管理台', `标题异常：${state.title}`);
    assert(state.authShown, '登录层未显示');
    assert(state.shellHidden, '未登录时台账不应显示');
    assert(state.hasLogin, '缺少登录输入框');
  });

  await check('未登录时台账脚本未加载', async () => {
    const loaded = await cdp.eval(`return !!window.__FIN_APP__;`);
    assert(loaded === false, '未登录就加载了台账脚本');
  });

  console.log('\n登录与台账渲染：');
  await check('用管理员账号登录（首登要求改密）', async () => {
    const out = await cdp.eval(`
      document.getElementById('loginUser').value = ${JSON.stringify(ADMIN.username)};
      document.getElementById('loginPwd').value = ${JSON.stringify(ADMIN.password)};
      document.getElementById('btnLogin').click();
      await new Promise(r => setTimeout(r, 1500));
      return { changeShown: document.getElementById('changePanel').style.display !== 'none' };
    `);
    assert(out.changeShown, '首次登录应弹出改密面板');
  });

  await check('完成强制改密并重新登录', async () => {
    const out = await cdp.eval(`
      document.getElementById('curPwd').value = ${JSON.stringify(ADMIN.password)};
      document.getElementById('newPwd1').value = 'Browser54321';
      document.getElementById('newPwd2').value = 'Browser54321';
      document.getElementById('btnChangeSubmit').click();
      await new Promise(r => setTimeout(r, 1500));
      document.getElementById('loginUser').value = ${JSON.stringify(ADMIN.username)};
      document.getElementById('loginPwd').value = 'Browser54321';
      document.getElementById('btnLogin').click();
      await new Promise(r => setTimeout(r, 2500));
      return {
        authHidden: !document.getElementById('authOverlay').classList.contains('show'),
        appLoaded: !!window.__FIN_APP__,
        role: window.__FIN_ME__ && window.__FIN_ME__.user.role,
        chip: document.getElementById('userChip').textContent
      };
    `);
    assert(out.authHidden, '登录后仍显示登录层');
    assert(out.appLoaded, '台账脚本未加载');
    assert(out.role === 'admin', `角色异常：${out.role}`);
    assert(out.chip.includes('管理员'), `身份区未显示角色：${out.chip}`);
  });

  await check('总览页与各模块页签渲染完成', async () => {
    const out = await cdp.eval(`
      return {
        tabs: Array.from(document.querySelectorAll('.mod-tab[data-mod]')).map(t => t.getAttribute('data-mod')),
        modKeys: Object.keys(window.__FIN_APP__.modules),
        overviewVisible: document.getElementById('overviewCard').style.display !== 'none',
        cards: document.getElementById('ovStats').children.length,
        sync: document.getElementById('syncText').textContent
      };
    `);
    /*
     * 页签数 = 注册表模块数 + 总览，KPI 卡片数 = 注册表模块数。
     * 原来这里写死 7 和 6，加一个模块就会失败——失败的是断言，不是程序。
     * 真正要守住的是「注册表里的每个模块都有页签、都有卡片」这个一致性。
     */
    const expectTabs = out.modKeys.length + 1;
    assert(out.tabs.length === expectTabs, `页签应 ${expectTabs} 个（${out.modKeys.length} 模块 + 总览），实际 ${out.tabs.join(',')}`);
    for (const k of out.modKeys) {
      assert(out.tabs.includes(k), `缺少模块页签 ${k}`);
    }
    for (const k of ['facility', 'levy', 'union', 'asset', 'baddebt', 'lvc']) {
      assert(out.modKeys.includes(k), `核心模块 ${k} 从注册表里消失了`);
    }
    assert(out.overviewVisible, '总览未显示');
    assert(out.cards === out.modKeys.length, `总览 KPI 卡片应 ${out.modKeys.length} 个，实际 ${out.cards}`);
    assert(out.sync === '已同步', `同步状态异常：${out.sync}`);
  });

  await check('切到「设施摊销」并加载服务端数据', async () => {
    const out = await cdp.eval(`
      window.__FIN_APP__.switchModule('facility', true);
      await new Promise(r => setTimeout(r, 1800));
      return {
        title: document.getElementById('cardTitle').textContent,
        online: window.__FIN_APP__.modules.facility.online,
        cols: document.querySelectorAll('#thead th').length,
        empty: document.getElementById('emptyBox').style.display
      };
    `);
    assert(out.title === '摊销台账', `卡片标题异常：${out.title}`);
    assert(out.online === true, '模块未进入联机模式（说明 schema 请求失败）');
    assert(out.cols > 5, `表头列数异常：${out.cols}`);
  });

  console.log('\n录入与结账：');
  await check('通过界面表单新增一条设施', async () => {
    const out = await cdp.eval(`
      document.getElementById('btnAdd').click();
      await new Promise(r => setTimeout(r, 400));
      function set(name, value){
        var el = document.querySelector('#formBody [name="' + name + '"]');
        if(!el) throw new Error('表单缺少字段 ' + name);
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      set('name', '自检板房');
      set('unit', '一分公司');
      set('category', '房屋类设施');
      set('method', '直线法');
      set('cost', '240000');
      set('residual', '5');
      set('start_date', '2026-01-01');
      set('book_date', '2026-01-01');
      set('months', '24');
      set('status', '使用中');
      document.getElementById('btnSubmit').click();
      await new Promise(r => setTimeout(r, 2200));
      var rows = Array.from(document.querySelectorAll('#tbody tr'));
      return {
        maskOpen: document.getElementById('mask').className.indexOf('open') > -1,
        rowCount: rows.length,
        rowText: rows.map(r => r.textContent).join(' | ')
      };
    `);
    assert(!out.maskOpen, '保存后弹窗未关闭，说明保存失败');
    assert(out.rowCount === 1, `台账应有 1 行，实际 ${out.rowCount}`);
    assert(out.rowText.includes('自检板房'), `表格未显示新记录：${out.rowText}`);
  });

  await check('摊销金额按启用日期正确计算', async () => {
    const out = await cdp.eval(`
      window.__FIN_APP__.renderPeriodBar();
      document.getElementById('pbYm').value = '2026-03';
      document.getElementById('pbYm').dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 1500));
      var tds = Array.from(document.querySelectorAll('#tbody tr:first-child td')).map(td => td.textContent.trim());
      var heads = Array.from(document.querySelectorAll('#thead th')).map(th => th.textContent.trim());
      var out = {};
      heads.forEach(function(h, i){ out[h] = tds[i]; });
      return out;
    `);
    // 原值 240000、残值 5% → 可摊 228000；24 个月 → 每月 9500；2026-01 启用，至 2026-03 共 3 个月
    assert(out['本月摊销金额'] === '9,500.00', `本月摊销异常：${out['本月摊销金额']}`);
    assert(out['开累摊销金额'] === '28,500.00', `开累摊销异常：${out['开累摊销金额']}`);
    assert(out['本月末账面净值'] === '211,500.00', `账面净值异常：${out['本月末账面净值']}`);
  });

  await check('结账后界面转只读', async () => {
    const out = await cdp.eval(`
      var btn = document.querySelector('#modClose [data-close]');
      if(!btn) throw new Error('找不到结账按钮');
      window.confirm = function(){ return true; };
      btn.click();
      await new Promise(r => setTimeout(r, 1800));
      return {
        addDisabled: document.getElementById('btnAdd').disabled,
        pill: document.querySelector('#modClose .mc-pill').textContent,
        hasReopen: !!document.querySelector('#modClose [data-reopen]'),
        /* 结账落到哪个期间由两层期间模型决定，下一步要拿它去比服务端记录 */
        lockYm: window.__FIN_APP__.lockYmOf(window.__FIN_APP__.modules.facility),
        bookYm: window.__FIN_APP__.bookYm(),
        viewYm: window.__FIN_APP__.viewYm()
      };
    `);
    assert(out.addDisabled, '结账后新增按钮应禁用');
    assert(out.pill.includes('已结账'), `结账标记异常：${out.pill}`);
    assert(out.hasReopen, '结账后应出现重开按钮');
    /*
     * 设施摊销没有「会计期间」字段 → 锁的是账套期间，而不是刚才切过去的视图期间。
     * 原来这一步的下一个断言写死了 facility|2026-03（= 视图期间），
     * 于是账套期间一旦不是 3 月（比如今天是 8 月，新装账套默认当月）就必然失败——
     * 失败的是断言，不是程序。顺手把两层期间的这条关键行为钉在这里。
     */
    assert(out.lockYm === out.bookYm, `facility 无期间字段，应锁账套期间 ${out.bookYm}，实际锁了 ${out.lockYm}`);
    closedYm = out.lockYm;
  });

  await check('结账状态已落到服务端（换浏览器上下文仍生效）', async () => {
    const r = await cdp.eval(`
      var resp = await fetch('/api/closures', { credentials: 'same-origin' });
      var data = await resp.json();
      return data.closures.map(function(c){ return c.module + '|' + c.period; });
    `);
    assert(r.includes(`facility|${closedYm}`), `服务端应有 facility|${closedYm}，实际 ${JSON.stringify(r)}`);
  });

  await check('结账期间内保存被服务端拒绝', async () => {
    const out = await cdp.eval(`
      var resp = await fetch('/api/modules/facility/records', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ properties: { '设施名称': { text: '越权写入' } } })
      });
      return { status: resp.status, body: await resp.json() };
    `);
    assert(out.status === 409, `期望 409，实际 ${out.status}`);
    // 这一步会在控制台留下预期内的 409 网络错误，从事件缓冲里剔除，避免污染最后的清洁度断言
    cdp.events = cdp.events.filter((e) => !(e.method === 'Log.entryAdded' && /409/.test(e.params.entry.text || '')));
  });

  await check('重开后恢复可编辑', async () => {
    const out = await cdp.eval(`
      window.confirm = function(){ return true; };
      document.querySelector('#modClose [data-reopen]').click();
      await new Promise(r => setTimeout(r, 1800));
      return {
        addDisabled: document.getElementById('btnAdd').disabled,
        pill: document.querySelector('#modClose .mc-pill').textContent
      };
    `);
    assert(!out.addDisabled, '重开后新增按钮应可用');
    assert(out.pill.includes('处理中'), `重开后状态异常：${out.pill}`);
  });

  console.log('\n报表与导出：');
  await check('打印内容可正常组装（含大写金额与单位名）', async () => {
    const out = await cdp.eval(`
      var mod = window.__FIN_APP__.modules.facility;
      var rows = mod.rows || [];
      var pe = new Date(2026, 3, 0);
      var calcs = {};
      rows.forEach(function(r){ calcs[r._id] = mod.rowCalc(r, pe); });
      window.print = function(){};
      mod.print.call(mod, rows, calcs);
      var area = document.getElementById('printArea');
      return { len: area.innerHTML.length, text: area.textContent.slice(0, 600) };
    `);
    assert(out.len > 500, `打印内容过短：${out.len}`);
    assert(out.text.includes('自检板房'), '打印内容缺少记录');
  });

  await check('Excel 导出能生成 xlsx Blob', async () => {
    const out = await cdp.eval(`
      var created = null;
      var origCreate = URL.createObjectURL;
      URL.createObjectURL = function(blob){ created = { size: blob.size, type: blob.type }; return 'blob:stub'; };
      var origClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function(){};
      try {
        document.querySelector('#menuExport [data-act="xlsMonth"]').click();
        await new Promise(r => setTimeout(r, 800));
      } finally {
        URL.createObjectURL = origCreate;
        HTMLAnchorElement.prototype.click = origClick;
      }
      return created;
    `);
    assert(out && out.size > 800, `导出的 xlsx 异常：${JSON.stringify(out)}`);
  });

  await check('操作日志面板能拉到记录', async () => {
    const out = await cdp.eval(`
      window.__FIN_MENU__.audit();
      await new Promise(r => setTimeout(r, 1500));
      var body = document.getElementById('adminBody').textContent;
      return { open: document.getElementById('adminMask').className.indexOf('open') > -1, hasRows: body.indexOf('新增记录') >= 0 || body.indexOf('结账') >= 0 };
    `);
    assert(out.open, '面板未打开');
    assert(out.hasRows, '日志内容为空');
  });

  await check('账号管理面板能列出账号', async () => {
    const out = await cdp.eval(`
      document.getElementById('btnAdminClose').click();
      window.__FIN_MENU__.users();
      await new Promise(r => setTimeout(r, 1500));
      var body = document.getElementById('adminBody').textContent;
      return { hasAdmin: body.indexOf(${JSON.stringify(ADMIN.username)}) >= 0, hasRoleSel: !!document.querySelector('[data-role-for]') };
    `);
    assert(out.hasAdmin, '账号列表里没有管理员');
    assert(out.hasRoleSel, '缺少角色下拉');
  });

  console.log('\n受控清单 / 结转 / 粘贴导入：');
  await check('单位清单为空时，录入界面仍是自由文本（新装可用）', async () => {
    const out = await cdp.eval(`
      document.getElementById('btnAdminClose').click();
      window.__FIN_APP__.switchModule('facility', true);
      await new Promise(r => setTimeout(r, 1200));
      document.getElementById('btnAdd').click();
      await new Promise(r => setTimeout(r, 400));
      var el = document.querySelector('#formBody [name="unit"]');
      var warn = document.querySelector('#formBody .field-warn');
      var tag = el.tagName;
      document.getElementById('btnCancel').click();
      return { tag: tag, hasWarn: !!warn };
    `);
    assert(out.tag === 'INPUT', `清单为空时单位应是文本框，实际 ${out.tag}`);
    assert(out.hasWarn, '应提示建议先建清单');
  });

  await check('清单面板可添加单位与项目', async () => {
    const out = await cdp.eval(`
      window.__FIN_APP__.openMasterData();
      await new Promise(r => setTimeout(r, 1200));
      document.getElementById('mdUnitInput').value = '一分公司';
      document.getElementById('mdUnitAdd').click();
      await new Promise(r => setTimeout(r, 1200));
      var unitsText = document.getElementById('adminBody').textContent;

      document.getElementById('mdTabProj').click();
      await new Promise(r => setTimeout(r, 300));
      document.getElementById('mdProjUnit').value = '一分公司';
      document.getElementById('mdProjInput').value = '自检道路项目';
      document.getElementById('mdProjRate').value = '2';
      document.getElementById('mdProjAdd').click();
      await new Promise(r => setTimeout(r, 1200));
      return {
        unitsText: unitsText,
        projText: document.getElementById('adminBody').textContent,
        master: window.__FIN_MASTER__
      };
    `);
    assert(out.unitsText.includes('一分公司'), '单位未出现在清单里');
    assert(out.projText.includes('自检道路项目'), '项目未出现在清单里');
    assert(out.master.units.some((u) => u.name === '一分公司'), '前端清单快照未刷新');
    assert(out.master.projects.some((p) => p.name === '自检道路项目' && p.rate === 2), '项目比例未带回前端');
  });

  await check('清单建立后录入界面改为下拉选择，选中项目自动带出比例', async () => {
    const out = await cdp.eval(`
      document.getElementById('btnAdminClose').click();
      window.__FIN_APP__.switchModule('levy', true);
      await new Promise(r => setTimeout(r, 1500));
      document.getElementById('btnAdd').click();
      await new Promise(r => setTimeout(r, 400));
      function fire(el){
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      var unitEl = document.querySelector('#formBody [name="unit"]');
      var unitTag = unitEl.tagName;
      var unitOpts = Array.from(unitEl.options || []).map(function(o){ return o.value; });
      unitEl.value = '一分公司';
      fire(unitEl);
      await new Promise(r => setTimeout(r, 300));
      var projEl = document.querySelector('#formBody [name="proj"]');
      var projTag = projEl.tagName;
      var projOpts = Array.from(projEl.options || []).map(function(o){ return o.value; });
      // 选中项目后，清单里登记的计提比例应自动填入
      projEl.value = '自检道路项目';
      fire(projEl);
      await new Promise(r => setTimeout(r, 300));
      var rateAuto = document.querySelector('#formBody [name="rate"]').value;
      // 手改比例后不应再被清单值冲掉
      var rateEl = document.querySelector('#formBody [name="rate"]');
      rateEl.value = '2.5';
      fire(rateEl);
      await new Promise(r => setTimeout(r, 200));
      return {
        unitTag: unitTag, unitOpts: unitOpts,
        projTag: projTag, projOpts: projOpts,
        rateAuto: rateAuto,
        rateKept: document.querySelector('#formBody [name="rate"]').value
      };
    `);
    assert(out.unitTag === 'SELECT', `单位应改为下拉，实际 ${out.unitTag}`);
    assert(out.unitOpts.includes('一分公司'), `单位选项异常：${out.unitOpts.join(',')}`);
    assert(out.projTag === 'SELECT', `项目应改为下拉，实际 ${out.projTag}`);
    assert(out.projOpts.includes('自检道路项目'), `项目选项未随单位联动：${out.projOpts.join(',')}`);
    assert(out.rateAuto === '2', `应自动带出清单登记的比例 2，实际 ${out.rateAuto}`);
    assert(out.rateKept === '2.5', `手改后的比例应保留，实际 ${out.rateKept}`);
  });

  await check('通过界面录入上期（3 月）专项费用', async () => {
    const out = await cdp.eval(`
      function set(name, value){
        var el = document.querySelector('#formBody [name="' + name + '"]');
        if(!el) throw new Error('表单缺少字段 ' + name);
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      set('unit', '一分公司');
      set('proj', '自检道路项目');
      set('period', '2026-03');
      set('rate', '2');
      set('cum', '5000000');
      document.getElementById('btnSubmit').click();
      await new Promise(r => setTimeout(r, 2200));
      return {
        maskOpen: document.getElementById('mask').className.indexOf('open') > -1,
        rowText: Array.from(document.querySelectorAll('#tbody tr')).map(function(r){ return r.textContent; }).join(' | ')
      };
    `);
    assert(!out.maskOpen, '保存后弹窗未关闭，说明保存失败');
    assert(out.rowText.includes('自检道路项目'), `台账未显示新记录：${out.rowText}`);
  });

  await check('结转面板列出上期名册并带上期数值', async () => {
    const out = await cdp.eval(`
      document.getElementById('pbYm').value = '2026-04';
      document.getElementById('pbYm').dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 1500));
      window.__FIN_APP__.openCarry();
      await new Promise(r => setTimeout(r, 1800));
      return {
        open: document.getElementById('adminMask').className.indexOf('open') > -1,
        from: document.getElementById('carryFrom').value,
        to: document.getElementById('carryTo').value,
        body: document.getElementById('carryBody').textContent,
        inputs: document.querySelectorAll('#carryBody [data-carry-id]').length
      };
    `);
    assert(out.open, '结转面板未打开');
    assert(out.from === '2026-03', `来源期间应默认上一期，实际 ${out.from}`);
    assert(out.to === '2026-04', `目标期间应为当前期间，实际 ${out.to}`);
    assert(out.body.includes('自检道路项目'), `名册里没有上期项目：${out.body.slice(0, 200)}`);
    assert(out.inputs === 1, `应有 1 个待填输入框，实际 ${out.inputs}`);
  });

  await check('结转写入本期，比例与名称照抄、只有数字是新的', async () => {
    const out = await cdp.eval(`
      window.confirm = function(){ return true; };
      var inp = document.querySelector('#carryBody [data-carry-id]');
      inp.value = '6200000';
      document.getElementById('carryConfirm').click();
      await new Promise(r => setTimeout(r, 2500));
      var mod = window.__FIN_APP__.modules.levy;
      var apr = (mod.rows || []).filter(function(r){ return String(r['会计期间']).indexOf('2026-04') === 0; });
      return {
        panelClosed: document.getElementById('adminMask').className.indexOf('open') < 0,
        count: apr.length,
        rec: apr[0] || null
      };
    `);
    assert(out.panelClosed, '结转成功后面板应关闭');
    assert(out.count === 1, `4 月应生成 1 条，实际 ${out.count}`);
    assert(out.rec['项目名称'] === '自检道路项目', `项目名未照抄：${out.rec['项目名称']}`);
    assert(out.rec['计提比例(%)'] === 2, `比例未照抄：${out.rec['计提比例(%)']}`);
    assert(out.rec['累计产值(元)'] === 6200000, `开累数字异常：${out.rec['累计产值(元)']}`);
  });

  await check('结转出来的记录本期计提按差额计算', async () => {
    const out = await cdp.eval(`
      await new Promise(r => setTimeout(r, 800));
      var tds = Array.from(document.querySelectorAll('#tbody tr:first-child td')).map(function(td){ return td.textContent.trim(); });
      var heads = Array.from(document.querySelectorAll('#thead th')).map(function(th){ return th.textContent.trim(); });
      var o = {};
      heads.forEach(function(h, i){ o[h] = tds[i]; });
      return o;
    `);
    // 6,200,000 − 5,000,000 = 1,200,000 本期产值；×2% = 24,000
    const curVal = out['当期产值'] || '';
    const accr = out['本期计提金额'] || '';
    assert(curVal.includes('1,200,000'), `当期产值应为 1,200,000，实际「${curVal}」（列名：${Object.keys(out).join(',')}）`);
    assert(accr.includes('24,000'), `本期计提应为 24,000，实际「${accr}」`);
  });

  await check('粘贴导入面板能预检出正确与错误行', async () => {
    const out = await cdp.eval(`
      window.__FIN_APP__.openPaste();
      await new Promise(r => setTimeout(r, 800));
      document.getElementById('pasteModule').value = 'levy';
      document.getElementById('pasteModule').dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 500));
      document.getElementById('pastePeriod').value = '2026-05';
      // 三行：正常、清单外项目、金额不是数字
      document.getElementById('pasteArea').value = [
        '一分公司\\t自检道路项目\\t7,300,000\\t2',
        '一分公司\\t清单外项目\\t8000000\\t2',
        '一分公司\\t自检道路项目\\t不是数字\\t2'
      ].join('\\n');
      document.getElementById('pasteCheck').click();
      await new Promise(r => setTimeout(r, 1800));
      var pv = document.getElementById('pastePreview').textContent;
      return { text: pv, hasConfirm: !!document.getElementById('pasteConfirm') };
    `);
    assert(/共 3 行/.test(out.text), `预检行数异常：${out.text.slice(0, 200)}`);
    assert(/1 行可导入/.test(out.text), `应只有 1 行可导入：${out.text.slice(0, 300)}`);
    assert(out.text.includes('清单外项目') || out.text.includes('受控清单'), `未报出清单外项目：${out.text.slice(0, 300)}`);
    assert(out.hasConfirm, '应出现导入按钮');
  });

  await check('粘贴导入只写入通过校验的行', async () => {
    const out = await cdp.eval(`
      window.confirm = function(){ return true; };
      document.getElementById('pasteConfirm').click();
      await new Promise(r => setTimeout(r, 2500));
      var resp = await fetch('/api/modules/levy/records', { credentials: 'same-origin' });
      var data = await resp.json();
      var may = data.results.filter(function(r){ return String(r['会计期间']).indexOf('2026-05') === 0; });
      return { count: may.length, rec: may[0] || null };
    `);
    assert(out.count === 1, `5 月应只写入 1 条，实际 ${out.count}`);
    assert(out.rec['累计产值(元)'] === 7300000, `千分位应归一为 7300000，实际 ${out.rec['累计产值(元)']}`);
  });

  await check('设施表单含期初接续字段且成对校验', async () => {
    const out = await cdp.eval(`
      window.__FIN_APP__.switchModule('facility', true);
      await new Promise(r => setTimeout(r, 1500));
      document.getElementById('btnAdd').click();
      await new Promise(r => setTimeout(r, 400));
      var hasOpenAmt = !!document.querySelector('#formBody [name="open_amt"]');
      var hasOpenYm = !!document.querySelector('#formBody [name="open_ym"]');
      function set(name, value){
        var el = document.querySelector('#formBody [name="' + name + '"]');
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      set('name', '期初接续板房');
      set('unit', '一分公司');
      set('cost', '120000');
      set('residual', '5');
      set('months', '24');
      set('start_date', '2025-01-01');
      set('open_amt', '47500');   // 只填金额、不填截止期间 → 应被拦住
      document.getElementById('btnSubmit').click();
      await new Promise(r => setTimeout(r, 700));
      var stillOpen = document.getElementById('mask').className.indexOf('open') > -1;
      var toastText = document.getElementById('toast').textContent;
      set('open_ym', '2025-12');
      var preview = document.getElementById('preview').textContent;
      document.getElementById('btnSubmit').click();
      await new Promise(r => setTimeout(r, 2200));
      return {
        hasOpenAmt: hasOpenAmt, hasOpenYm: hasOpenYm,
        blocked: stillOpen, toastText: toastText,
        preview: preview,
        saved: document.getElementById('mask').className.indexOf('open') < 0
      };
    `);
    assert(out.hasOpenAmt && out.hasOpenYm, '表单缺少期初接续字段');
    assert(out.blocked, '只填期初金额不填截止期间时应被拦住');
    assert(out.toastText.includes('期初截止期间'), `提示文案异常：${out.toastText}`);
    assert(out.preview.includes('期初接续'), `预览未切换到期初接续口径：${out.preview}`);
    assert(out.saved, '补齐截止期间后应能保存');
  });

  await check('期初接续的摊销从期初基数往下算', async () => {
    const out = await cdp.eval(`
      var mod = window.__FIN_APP__.modules.facility;
      var rec = (mod.rows || []).filter(function(r){ return r['设施名称'] === '期初接续板房'; })[0];
      if(!rec) throw new Error('未找到期初接续记录');
      // 应摊总额 114000，24 期 → 每期 4750；期初截至 2025-12 已摊 47500
      var c = mod.rowCalc(rec, new Date(2026, 3, 0));   // 2026-03
      return { monthly: c.monthly, accrued: c.accrued, curAmt: c.curAmt, opening: c.opening, openingYM: c.openingYM };
    `);
    assert(out.monthly === 4750, `月摊销额应为 4750，实际 ${out.monthly}`);
    assert(out.opening === 47500, `期初基数应为 47500，实际 ${out.opening}`);
    assert(out.openingYM === '2025-12', `期初截止期间应为 2025-12，实际 ${out.openingYM}`);
    // 2025-12 → 2026-03 共 3 个月：47500 + 3×4750 = 61750
    assert(out.accrued === 61750, `开累摊销应为 61750，实际 ${out.accrued}`);
    assert(out.curAmt === 4750, `本期摊销应为 4750，实际 ${out.curAmt}`);
  });

  console.log('\n数据完整性（截断防护）：');
  await check('数据没取全时界面停止计算并说明原因', async () => {
    /*
     * 这是本系统最危险的一类故障，所以必须在真实浏览器里验一遍，而不只是验接口。
     *
     * 服务端按 (期间, 创建时间) 升序返回，limit 砍掉的是**最新**的记录。
     * levy 的计提是链式的（本期 = 本期累计 − 上期累计），链条尾部被截掉后
     * 仍然算得出一个自洽但错误的金额，界面上没有任何迹象表明它是错的。
     * 这里把请求的 limit 改小来复现，然后要求界面拒绝显示任何数字。
     */
    const out = await cdp.eval(`
      /* 必须先切到 levy：reload() 只重载当前模块，前面几步停在 facility 上 */
      window.__FIN_APP__.switchModule('levy', true);
      await new Promise(r => setTimeout(r, 1800));
      window.__FIN_TRUNC_ORIG__ = window.fetch;
      window.fetch = function(u, o){
        if(typeof u === 'string' && u.indexOf('/records') > -1 && /limit=\\d+/.test(u)){
          u = u.replace(/limit=\\d+/, 'limit=1');
        }
        return window.__FIN_TRUNC_ORIG__.call(window, u, o);
      };
      window.__FIN_APP__.reload();
      await new Promise(r => setTimeout(r, 2200));
      var mod = window.__FIN_APP__.modules.levy;
      return {
        curKey: window.__FIN_APP__.currentKey(),
        truncated: mod.truncated,
        serverTotal: mod.serverTotal,
        got: (mod.rows || []).length,
        bodyRows: document.querySelectorAll('#tbody tr').length,
        headCols: document.querySelectorAll('#thead th').length,
        statCount: (document.getElementById('statCount') || {}).textContent,
        statAccrued: (document.getElementById('statAccrued') || {}).textContent,
        emptyText: document.getElementById('emptyBox').textContent,
        hint: document.getElementById('cardHint').textContent
      };
    `);
    assert(out.curKey === 'levy', `应停在 levy 上，实际 ${out.curKey}`);
    assert(out.truncated === true, `模块应标记为数据不全，实际 ${out.truncated}`);
    assert(out.got === 1, `本次应只拿到 1 条，实际 ${out.got}`);
    assert(out.serverTotal > 1, `服务端总数应大于 1，实际 ${out.serverTotal}`);
    assert(out.bodyRows === 0, `不完整时不能渲染任何数据行，实际 ${out.bodyRows} 行`);
    assert(out.headCols === 0, `不完整时不该有表头，实际 ${out.headCols} 列`);
    assert(out.statCount === '—', `合计数字必须清空，实际「${out.statCount}」`);
    assert(out.statAccrued === '—', `计提合计必须清空，实际「${out.statAccrued}」`);
    assert(out.emptyText.includes('数据未取全'), `界面应说明原因，实际「${out.emptyText.slice(0, 80)}」`);
    assert(out.emptyText.includes('停止计算'), `界面应说明已停止计算，实际「${out.emptyText.slice(0, 80)}」`);
    assert(out.hint.includes('数据不完整'), `卡片标题应带提示，实际「${out.hint}」`);
  });

  await check('数据没取全时打印与导出被一并挡住', async () => {
    /*
     * 屏幕上已经拒绝显示金额了，但打印和 Excel 走各自的取值路径。
     * 不挡的话仍会导出一份用残缺链条算出来的、看起来正常的报表——
     * 那比屏幕上显示错数字更危险，因为它会被打印出来签字归档。
     */
    const out = await cdp.eval(`
      var results = {};
      var acts = ['printMonth', 'printAll', 'xlsMonth', 'xlsAll'];
      var origPrint = window.print;
      var origCreate = URL.createObjectURL;
      var origClick = HTMLAnchorElement.prototype.click;
      var printed = 0, blobs = 0;
      window.print = function(){ printed++; };
      URL.createObjectURL = function(b){ blobs++; return 'blob:stub'; };
      HTMLAnchorElement.prototype.click = function(){};
      try {
        for (var i = 0; i < acts.length; i++) {
          document.getElementById('printArea').innerHTML = '';
          var btn = document.querySelector('#menuExport [data-act="' + acts[i] + '"]');
          if(!btn) throw new Error('找不到菜单项 ' + acts[i]);
          btn.click();
          await new Promise(r => setTimeout(r, 700));
          results[acts[i]] = {
            toast: document.getElementById('toast').textContent,
            printLen: document.getElementById('printArea').innerHTML.length
          };
        }
      } finally {
        window.print = origPrint;
        URL.createObjectURL = origCreate;
        HTMLAnchorElement.prototype.click = origClick;
      }
      return { results: results, printed: printed, blobs: blobs };
    `);
    assert(out.printed === 0, `不完整数据不能触发打印，实际调用了 ${out.printed} 次`);
    assert(out.blobs === 0, `不完整数据不能生成导出文件，实际生成了 ${out.blobs} 个`);
    for (const [act, r] of Object.entries(out.results)) {
      assert(r.printLen === 0, `${act} 不该组装出打印内容，实际 ${r.printLen} 字符`);
      assert(r.toast.includes('数据未取全'), `${act} 应提示数据未取全，实际「${r.toast}」`);
    }
  });

  await check('恢复完整加载后计算与导出重新可用', async () => {
    const out = await cdp.eval(`
      if(window.__FIN_TRUNC_ORIG__){ window.fetch = window.__FIN_TRUNC_ORIG__; delete window.__FIN_TRUNC_ORIG__; }
      window.__FIN_APP__.reload();
      await new Promise(r => setTimeout(r, 2200));
      var mod = window.__FIN_APP__.modules.levy;
      var created = null;
      var origCreate = URL.createObjectURL;
      var origClick = HTMLAnchorElement.prototype.click;
      URL.createObjectURL = function(b){ created = { size: b.size }; return 'blob:stub'; };
      HTMLAnchorElement.prototype.click = function(){};
      try {
        document.querySelector('#menuExport [data-act="xlsAll"]').click();
        await new Promise(r => setTimeout(r, 900));
      } finally {
        URL.createObjectURL = origCreate;
        HTMLAnchorElement.prototype.click = origClick;
      }
      return {
        truncated: mod.truncated,
        got: (mod.rows || []).length,
        serverTotal: mod.serverTotal,
        bodyRows: document.querySelectorAll('#tbody tr').length,
        sync: document.getElementById('syncText').textContent,
        exported: created
      };
    `);
    assert(out.truncated === false, `恢复后不应再标记不完整，实际 ${out.truncated}`);
    assert(out.got === out.serverTotal, `应取全 ${out.serverTotal} 条，实际 ${out.got} 条`);
    assert(out.bodyRows > 0, '恢复后应重新渲染数据行');
    assert(out.sync === '已同步', `同步状态异常：${out.sync}`);
    assert(out.exported && out.exported.size > 800, `导出应恢复可用：${JSON.stringify(out.exported)}`);
  });

  console.log('\n漏录提醒：');
  await check('总览页把「上期有、本期缺」的名册摆出来', async () => {
    /*
     * 少计提在账面上每一条都是对的，只有拿总数跟上期比才能发现，
     * 而月结时没人会去比。所以它必须是打开系统第一眼就看见的东西。
     *
     * 此前几步已经录到 5 月（3 月手录、4 月结转、5 月粘贴导入），
     * 所以这里把账套期间推到 6 月：5 月有名册、6 月还没录 → 应当提醒。
     */
    const out = await cdp.eval(`
      var resp = await fetch('/api/period', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period: '2026-06' })
      });
      var ok = resp.ok;
      window.__FIN_APP__.switchModule('__overview', true);
      await new Promise(r => setTimeout(r, 2200));
      var todos = document.getElementById('ovTodos');
      return {
        periodOk: ok,
        text: todos.textContent,
        hasTag: todos.textContent.indexOf('本期漏录') > -1,
        gotoBtns: Array.from(todos.querySelectorAll('[data-goto]')).map(function(b){ return b.getAttribute('data-goto'); })
      };
    `);
    assert(out.periodOk, '推进账套期间失败');
    assert(out.hasTag, `总览页应出现「本期漏录」提醒：${out.text.slice(0, 200)}`);
    assert(out.text.includes('自检道路项目'), `漏录名单应含上期的项目：${out.text.slice(0, 300)}`);
    assert(out.text.includes('本月结转'), `应告诉用户怎么补齐：${out.text.slice(0, 300)}`);
    assert(out.gotoBtns.includes('levy'), `应有跳转到 levy 的按钮：${out.gotoBtns.join(',')}`);
  });

  await check('漏录提醒计入「今天要处理」的总数', async () => {
    const out = await cdp.eval(`
      var h2 = document.querySelector('#ovTodos h2');
      var missing = document.querySelectorAll('#ovTodos .attention-item').length;
      return { title: h2 ? h2.textContent : '', items: missing };
    `);
    const m = out.title.match(/共\s*(\d+)\s*项/);
    assert(m, `标题应写明总项数，实际「${out.title}」`);
    assert(Number(m[1]) === out.items, `标题总数 ${m[1]} 应等于实际条目数 ${out.items}`);
  });

  await check('低值易耗品出现在结转模块下拉里（结转不再只覆盖两个模块）', async () => {
    const out = await cdp.eval(`
      window.__FIN_APP__.switchModule('lvc', true);
      await new Promise(r => setTimeout(r, 1500));
      window.__FIN_APP__.openCarry();
      await new Promise(r => setTimeout(r, 1500));
      var sel = document.getElementById('carryModule');
      var opts = Array.from(sel.options).map(function(o){ return o.value; });
      var selected = sel.value;
      var label = document.getElementById('carryBody').textContent;
      document.getElementById('btnAdminClose').click();
      return { opts: opts, selected: selected, label: label, serverKeys: (window.__FIN_MASTER__ || {}).carryModules || [] };
    `);
    assert(out.opts.includes('lvc'), `下拉应含 lvc，实际 ${out.opts.join(',')}`);
    assert(out.selected === 'lvc', `进入 lvc 后应默认选中它，实际 ${out.selected}`);
    assert(out.serverKeys.includes('lvc'), `服务端 carryModules 应含 lvc，实际 ${out.serverKeys.join(',')}`);
    /* 下拉是从服务端 carryModules 推导的，不能再是前端手抄的常量 */
    for (const k of out.serverKeys) {
      assert(out.opts.includes(k), `服务端声明可结转的 ${k} 没有出现在下拉里`);
    }
  });

  console.log('\n业务校验与勾稽提醒：');
  await check('绕过表单直调 API 也写不进负数金额（服务端兜底）', async () => {
    const out = await cdp.eval(`
      var resp = await fetch('/api/modules/facility/records', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ properties: { '单位': { text: '一分公司' }, '设施名称': { text: '负数兜底测试' }, '原值(元)': { number: -1000 } } })
      });
      return { status: resp.status, body: await resp.json() };
    `);
    assert(out.status === 400, `期望 400，实际 ${out.status}`);
    assert(String(out.body.error).includes('负数'), JSON.stringify(out.body));
    cdp.events = cdp.events.filter((e) => !(e.method === 'Log.entryAdded' && /400/.test(e.params.entry.text || '')));
  });

  await check('删除链式记录前会列出后续期间的重算影响', async () => {
    const out = await cdp.eval(`
      document.getElementById('pbYm').value = '2026-03';
      document.getElementById('pbYm').dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 1500));
      window.__FIN_APP__.switchModule('levy', true);
      await new Promise(r => setTimeout(r, 1800));
      var row = Array.from(document.querySelectorAll('#tbody tr')).find(function(tr){
        return tr.textContent.indexOf('2026年03月') >= 0;
      });
      if(!row) return { fail: '找不到 3 月记录行：' + document.getElementById('tbody').textContent.slice(0, 120) };
      var captured = null;
      window.confirm = function(m){ captured = m; return false; };   /* 只截获文案，不真删 */
      row.querySelector('[data-del]').click();
      await new Promise(r => setTimeout(r, 500));
      window.confirm = function(){ return true; };
      return { captured: captured };
    `);
    assert(!out.fail, String(out.fail));
    assert(out.captured && out.captured.includes('重算'), `确认框应列出重算影响：${out.captured}`);
    assert(out.captured.includes('2026-04'), `应点名 4 月受影响：${out.captured}`);
    /* 3 月开累 500 万被删后，4 月成为链首：6,200,000×2% = 124,000（原 24,000） */
    assert(out.captured.includes('124,000'), `4 月计提应重算为 124,000：${out.captured}`);
  });

  await check('科目余额表借贷不平衡会进「勾稽异常」提醒', async () => {
    const out = await cdp.eval(`
      document.getElementById('pbYm').value = '2026-06';
      document.getElementById('pbYm').dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 1200));
      var rows = [
        { '会计期间': '2026-06-01', '科目代码': '1001', '科目名称': '库存现金',
          '期初借方(元)': 1200, '本期借方发生(元)': 600, '期末借方余额(元)': 1800 },
        { '会计期间': '2026-06-01', '科目代码': '1002', '科目名称': '银行存款',
          '期初贷方(元)': 1000, '本期贷方发生(元)': 500, '期末贷方余额(元)': 1500 }
      ];
      for (var i = 0; i < rows.length; i++) {
        var props = {};
        Object.keys(rows[i]).forEach(function(k){
          props[k] = typeof rows[i][k] === 'number' ? { number: rows[i][k] } : { text: rows[i][k] };
        });
        var resp = await fetch('/api/modules/balance/records', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ properties: props })
        });
        if (!resp.ok) return { fail: resp.status, body: await resp.json() };
      }
      window.__FIN_APP__.switchModule('balance', true);
      await new Promise(r => setTimeout(r, 2200));
      var card = document.getElementById('attentionCard');
      return {
        shown: card && card.style.display !== 'none',
        text: (document.getElementById('attentionList') || {}).textContent || ''
      };
    `);
    assert(!out.fail, `造数失败：${JSON.stringify(out.fail || '')} ${JSON.stringify(out.body || '')}`);
    assert(out.shown, '借贷不平衡时应显示提醒卡片');
    assert(out.text.includes('借贷不平衡'), `提醒内容异常：${out.text.slice(0, 240)}`);
  });

  await check('银行资金台账期末余额勾稽不符会进提醒', async () => {
    const out = await cdp.eval(`
      var resp = await fetch('/api/modules/bank/records', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ properties: { '会计期间': { date: '2026-06-01' }, '账户': { text: '建行基本户' },
          '期初余额(元)': { number: 100000 }, '本期收入(元)': { number: 50000 },
          '本期支出(元)': { number: 20000 }, '期末余额(元)': { number: 999999 } } })
      });
      if (!resp.ok) return { fail: resp.status, body: await resp.json() };
      window.__FIN_APP__.switchModule('bank', true);
      await new Promise(r => setTimeout(r, 2200));
      var card = document.getElementById('attentionCard');
      return {
        shown: card && card.style.display !== 'none',
        text: (document.getElementById('attentionList') || {}).textContent || '',
        tag: (document.querySelector('#attentionList .tag') || {}).textContent || ''
      };
    `);
    assert(!out.fail, `造数失败：${JSON.stringify(out.fail || '')} ${JSON.stringify(out.body || '')}`);
    assert(out.shown, '勾稽不符时应显示提醒卡片');
    assert(out.text.includes('期末余额勾稽不符'), `提醒内容异常：${out.text.slice(0, 240)}`);
    assert(out.tag.includes('勾稽异常'), `标签应为「勾稽异常」，实际「${out.tag}」`);
  });

  console.log('\n只读角色：');
  await check('创建只读账号并以该身份重新登录', async () => {
    const out = await cdp.eval(`
      var resp = await fetch('/api/users', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'ro1', displayName: '只读用户', role: 'viewer' })
      });
      var created = await resp.json();
      // 先改掉强制改密，再换身份登录
      await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
      var login1 = await fetch('/api/login', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'ro1', password: created.initialPassword })
      });
      await fetch('/api/password', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: created.initialPassword, newPassword: 'Readonly12345' })
      });
      return { status: resp.status, login: login1.status };
    `);
    assert(out.status === 201, `创建只读账号失败：${out.status}`);
    // 换身份需要整页重载，让 bridge.js 重新引导
    await cdp.send('Page.navigate', { url: BASE + '/' });
    await sleep(1500);
    const after = await cdp.eval(`
      document.getElementById('loginUser').value = 'ro1';
      document.getElementById('loginPwd').value = 'Readonly12345';
      document.getElementById('btnLogin').click();
      await new Promise(r => setTimeout(r, 2800));
      return {
        role: window.__FIN_ME__ && window.__FIN_ME__.user.role,
        canWrite: window.__FIN_CAN__ && window.__FIN_CAN__.write,
        bodyClass: document.body.className,
        chip: document.getElementById('userChip').textContent
      };
    `);
    assert(after.role === 'viewer', `角色异常：${after.role}`);
    assert(after.canWrite === false, '只读账号 canWrite 应为 false');
    assert(after.bodyClass.includes('role-viewer'), `未加只读样式类：${after.bodyClass}`);
    assert(after.chip.includes('只读'), `身份区未显示只读：${after.chip}`);
  });

  await check('只读账号能看到台账数据但写操作入口被隐藏', async () => {
    const out = await cdp.eval(`
      window.__FIN_APP__.switchModule('facility', true);
      await new Promise(r => setTimeout(r, 2000));
      var addBtn = document.getElementById('btnAdd');
      var rows = document.querySelectorAll('#tbody tr');
      return {
        rowCount: rows.length,
        addVisible: getComputedStyle(addBtn).display !== 'none',
        editVisible: Array.from(document.querySelectorAll('[data-edit]')).some(function(b){ return getComputedStyle(b).display !== 'none'; }),
        delVisible: Array.from(document.querySelectorAll('[data-del]')).some(function(b){ return getComputedStyle(b).display !== 'none'; }),
        adminMenuVisible: Array.from(document.querySelectorAll('.menu [data-admin="1"]')).some(function(b){ return getComputedStyle(b).display !== 'none'; })
      };
    `);
    assert(out.rowCount >= 1, `只读账号应能看到数据，实际 ${out.rowCount} 行`);
    assert(!out.addVisible, '只读账号仍显示新增按钮');
    assert(!out.editVisible, '只读账号仍显示编辑按钮');
    assert(!out.delVisible, '只读账号仍显示删除按钮');
    assert(!out.adminMenuVisible, '只读账号仍显示管理员菜单项');
  });

  await check('只读账号绕过界面直接调接口也写不进（403）', async () => {
    const out = await cdp.eval(`
      var resp = await fetch('/api/modules/facility/records', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ properties: { '设施名称': { text: '只读越权' } } })
      });
      return resp.status;
    `);
    assert(out === 403, `期望 403，实际 ${out}`);
    cdp.events = cdp.events.filter((e) => !(e.method === 'Log.entryAdded' && /40[39]/.test(e.params.entry.text || '')));
  });

  await check('只读账号仍可正常打印与导出 Excel', async () => {
    const out = await cdp.eval(`
      var created = null;
      var origCreate = URL.createObjectURL;
      URL.createObjectURL = function(blob){ created = { size: blob.size }; return 'blob:stub'; };
      var origClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function(){};
      try {
        document.querySelector('#menuExport [data-act="xlsAll"]').click();
        await new Promise(r => setTimeout(r, 900));
      } finally {
        URL.createObjectURL = origCreate;
        HTMLAnchorElement.prototype.click = origClick;
      }
      return created;
    `);
    assert(out && out.size > 800, `只读账号导出失败：${JSON.stringify(out)}`);
  });

  console.log('\n控制台清洁度：');
  await check('全程无 JS 异常与资源加载失败', async () => {
    const errors = cdp.events
      .filter((e) => e.method === 'Log.entryAdded' && ['error'].includes(e.params.entry.level))
      .map((e) => `${e.params.entry.source}: ${e.params.entry.text}`)
      // 忽略无关的 favicon 之类资源噪声
      .filter((t) => !/favicon/i.test(t));
    const exceptions = cdp.events
      .filter((e) => e.method === 'Runtime.exceptionThrown')
      .map((e) => e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text);
    const all = [...errors, ...exceptions];
    assert(all.length === 0, `发现 ${all.length} 条错误：\n    ${all.slice(0, 6).join('\n    ')}`);
  });
} catch (err) {
  bad('浏览器自检异常', err.message);
  console.error(err);
} finally {
  if (cdp) cdp.close();
  console.log('\n' + '='.repeat(52));
  if (failures.length) {
    console.log(`结果：${passed} 项通过，${failures.length} 项失败`);
    for (const f of failures) console.log(`  ✗ ${f}`);
  } else {
    console.log(`结果：全部 ${passed} 项通过（浏览器：${browserPath}）`);
  }
  console.log('='.repeat(52) + '\n');
  cleanup();
  setTimeout(() => process.exit(failures.length ? 1 : 0), 800);
}
