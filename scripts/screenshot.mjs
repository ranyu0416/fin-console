#!/usr/bin/env node
/**
 * 给正在运行的实例截图，用来看效果（不改数据，只读+打开面板）。
 *   node scripts/screenshot.mjs http://127.0.0.1:8790 admin Demo123456 [输出目录]
 * 需要本机装了 Edge/Chrome。图片输出到 server/.shots/（已在 .gitignore 里）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(HERE, '..');
const BASE = process.argv[2] || 'http://127.0.0.1:8790';
const USER = process.argv[3] || 'admin';
const PWD = process.argv[4] || 'Demo123456';
const OUT = resolve(process.argv[5] || join(SERVER_ROOT, '.shots'));

const BROWSERS = [
  process.env.FIN_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const browserPath = BROWSERS.find((p) => existsSync(p));
if (!browserPath) {
  console.log('[shot] 未找到 Edge/Chrome，跳过截图');
  process.exit(0);
}

const CDP_PORT = 19700 + Math.floor(Math.random() * 200);
const PROFILE = mkdtempSync(join(tmpdir(), 'fin-shot-'));
mkdirSync(OUT, { recursive: true });

const browser = spawn(
  browserPath,
  [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--force-device-scale-factor=1',
    '--window-size=1500,1000',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'ignore'] },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function cleanup() {
  try { browser.kill(); } catch { /* 已退出 */ }
  setTimeout(() => { try { rmSync(PROFILE, { recursive: true, force: true }); } catch { /* ignore */ } }, 300);
}

async function waitFor(url, timeoutMs = 25000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch { /* 等 */ }
    await sleep(200);
  }
  throw new Error(`${url} 未就绪`);
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : res(msg.result);
      }
    });
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const out = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (out.exceptionDetails) {
      throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text);
    }
    return out.result.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

const shots = [];
async function shot(cdp, name, label) {
  const out = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = join(OUT, `${name}.png`);
  writeFileSync(file, Buffer.from(out.data, 'base64'));
  shots.push({ file, label });
  console.log(`  ✓ ${label} → ${file}`);
}

let cdp = null;
try {
  const list = await waitFor(`http://127.0.0.1:${CDP_PORT}/json/list`);
  const page = list.find((t) => t.type === 'page');
  cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false,
  });

  console.log(`\n[shot] 目标 ${BASE}，输出 ${OUT}\n`);

  await cdp.send('Page.navigate', { url: BASE + '/' });
  await sleep(1800);
  await shot(cdp, '01-登录', '登录界面');

  await cdp.eval(`
    document.getElementById('loginUser').value = ${JSON.stringify(USER)};
    document.getElementById('loginPwd').value = ${JSON.stringify(PWD)};
    document.getElementById('btnLogin').click();
    await new Promise(r => setTimeout(r, 3000));
    return true;
  `);
  await shot(cdp, '02-总览', '登录后总览页');

  await cdp.eval(`window.__FIN_APP__.switchModule('levy', true); await new Promise(r => setTimeout(r, 2000)); return true;`);
  await cdp.eval(`
    document.getElementById('pbYm').value = '2026-03';
    document.getElementById('pbYm').dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 2000));
    return true;
  `);
  await shot(cdp, '03-专项费用-上期', '专项费用台账（3 月，已结账只读）');

  await cdp.eval(`
    document.getElementById('pbYm').value = '2026-04';
    document.getElementById('pbYm').dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 2000));
    window.__FIN_APP__.openCarry();
    await new Promise(r => setTimeout(r, 2200));
    return true;
  `);
  await shot(cdp, '04-本月结转', '本月结转：上期名册整份列出');

  await cdp.eval(`
    var inputs = document.querySelectorAll('#carryBody [data-carry-id]');
    var vals = ['131900000', '45600000', '94100000', '58200000', '23350000'];
    inputs.forEach(function(inp, i){ inp.value = vals[i] || ''; });
    return true;
  `);
  await shot(cdp, '05-本月结转-已填', '本月结转：填好本期开累数');

  await cdp.eval(`
    window.confirm = function(){ return true; };
    document.getElementById('carryConfirm').click();
    await new Promise(r => setTimeout(r, 3000));
    return true;
  `);
  await shot(cdp, '06-结转结果', '结转结果：本期计提按差额自动算出');

  await cdp.eval(`window.__FIN_APP__.openPaste(); await new Promise(r => setTimeout(r, 900)); return true;`);
  await cdp.eval(`
    document.getElementById('pasteModule').value = 'lvc';
    document.getElementById('pasteModule').dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 600));
    document.getElementById('pasteArea').value = [
      '第一公司\\t绝缘手套\\t12kV\\t副\\t80\\t145',
      '第一公司\\t安全带\\t双钩五点式\\t条\\t60\\t268',
      '第二公司\\t电焊面罩\\t自动变光\\t个\\t25\\t不是数字',
      '不存在的公司\\t测试物料\\t\\t个\\t10\\t50'
    ].join('\\n');
    document.getElementById('pasteCheck').click();
    await new Promise(r => setTimeout(r, 2000));
    return true;
  `);
  await shot(cdp, '07-粘贴导入预检', 'Excel 粘贴导入：逐行预检');

  await cdp.eval(`
    document.getElementById('btnAdminClose').click();
    window.__FIN_APP__.openMasterData();
    await new Promise(r => setTimeout(r, 1800));
    return true;
  `);
  await shot(cdp, '08-单位清单', '单位受控清单');

  await cdp.eval(`
    document.getElementById('mdTabProj').click();
    await new Promise(r => setTimeout(r, 700));
    return true;
  `);
  await shot(cdp, '09-项目清单', '项目受控清单（带计提比例）');

  await cdp.eval(`
    document.getElementById('btnAdminClose').click();
    window.__FIN_APP__.switchModule('facility', true);
    await new Promise(r => setTimeout(r, 2200));
    return true;
  `);
  await shot(cdp, '10-设施摊销', '设施摊销（含期初接续的记录）');

  await cdp.eval(`
    document.getElementById('btnAdd').click();
    await new Promise(r => setTimeout(r, 700));
    function set(n, v){
      var el = document.querySelector('#formBody [name="' + n + '"]');
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    set('name', '旧账接续示例：拌合站');
    set('unit', '第一公司');
    set('cost', '960000');
    set('residual', '5');
    set('months', '36');
    set('start_date', '2024-10-01');
    set('open_amt', '456000');
    set('open_ym', '2026-03');
    document.querySelector('#formBody').scrollTop = 9999;
    await new Promise(r => setTimeout(r, 400));
    return true;
  `);
  await shot(cdp, '11-期初接续录入', '期初接续：填一次期初累计，不用补历史');

  await cdp.eval(`
    document.getElementById('btnCancel').click();
    window.__FIN_APP__.switchModule('asset', true);
    await new Promise(r => setTimeout(r, 2200));
    return true;
  `);
  await shot(cdp, '12-固定资产折旧', '固定资产折旧（含期初接续）');

  await cdp.eval(`
    window.__FIN_APP__.switchModule('union', true);
    await new Promise(r => setTimeout(r, 2200));
    return true;
  `);
  await shot(cdp, '13-工会经费', '工会·职工教育经费');

  await cdp.eval(`window.__FIN_MENU__.audit(); await new Promise(r => setTimeout(r, 2000)); return true;`);
  await shot(cdp, '14-操作日志', '操作日志（含结转与清单维护）');

  console.log(`\n[shot] 完成，共 ${shots.length} 张，目录：${OUT}\n`);
} catch (err) {
  console.error('[shot] 失败：', err.message);
  process.exitCode = 1;
} finally {
  if (cdp) cdp.close();
  cleanup();
  setTimeout(() => process.exit(process.exitCode || 0), 600);
}
