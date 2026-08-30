#!/usr/bin/env node
/**
 * 演示实例：起一个服务，预置一小套贴近真实的数据，用来看效果。
 *
 * 刻意准备成「上期已经录完、本期还没开始」的状态，这样一登录就能：
 *   1) 打开「⋯ → 本月结转」看到上期名册被整份列出来，只等填新数字
 *   2) 打开「⋯ → Excel 粘贴导入」直接粘一块单元格试
 *   3) 打开「⋯ → 单位/项目清单」看受控清单与改名连带改写
 *   4) 在设施/固定资产里看期初接续（不用逐月补历史）
 *
 * 用法：node scripts/demo.mjs [端口] [--reset] [--yes]
 * 数据写在 server/data-demo/ 下，与正式账套隔离；重置前会明确确认删除范围。
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import readline from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(HERE, '..');
const PORT = Number(process.argv[2]) || 8787;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = join(SERVER_ROOT, 'data-demo');
const ADMIN = { username: 'admin', password: 'Demo12345' };
const NEW_PWD = 'Demo123456';

const RESET = process.argv.includes('--reset');
const YES = process.argv.includes('--yes');
let child = null;

function confirmReset() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('确认删除此演示数据目录？输入 yes 继续：', (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'yes');
    });
  });
}

if (RESET && existsSync(DATA_DIR)) {
  console.log(`[demo] 即将删除演示数据目录：${resolve(DATA_DIR)}`);
  // 非交互环境无法确认操作者意图，必须显式 --yes，防止自动化任务静默清空演示账套。
  if (!process.stdin.isTTY && !YES) {
    console.error('[demo] 非交互环境使用 --reset 时必须同时传入 --yes。');
    process.exit(1);
  }
  if (process.stdin.isTTY && !YES && !(await confirmReset())) {
    console.log('[demo] 已取消重置。');
    process.exit(0);
  }
  rmSync(DATA_DIR, { recursive: true, force: true });
}

const FRESH = !existsSync(DATA_DIR);
child = spawn(process.execPath, ['server.js'], {
  cwd: SERVER_ROOT,
  env: {
    ...process.env,
    FIN_HOST: '127.0.0.1',
    FIN_PORT: String(PORT),
    FIN_DATA_DIR: DATA_DIR,
    FIN_ADMIN_USER: ADMIN.username,
    FIN_ADMIN_PASSWORD: ADMIN.password,
    FIN_ORG_NAME: '示例集团有限公司',
    FIN_BACKUP_INTERVAL_HOURS: '0',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

function cleanup() {
  if (child) {
    try { child.kill(); } catch { /* 子进程已退出 */ }
  }
}

process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

/* ---------- 带 cookie 的极简客户端 ---------- */
const jar = new Map();
async function api(path, { method = 'GET', body } = {}) {
  const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const init = { method, headers: { Accept: 'application/json', Origin: BASE, ...(cookie ? { Cookie: cookie } : {}) } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const resp = await fetch(BASE + path, init);
  for (const raw of resp.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    const i = pair.indexOf('=');
    jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  const ct = resp.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await resp.json() : await resp.text();
  if (resp.status >= 400) throw new Error(`${method} ${path} → ${resp.status}: ${JSON.stringify(data)}`);
  return data;
}

async function waitReady(ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`服务器退出，code ${child.exitCode}`);
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('服务器未就绪');
}

/* ---------- 预置数据 ---------- */
const UNITS = ['第一公司', '第二公司', '设备物资公司'];
const PROJECTS = [
  { unit: '第一公司', name: '示例项目一', rate: 2 },
  { unit: '第一公司', name: '示例项目二', rate: 2 },
  { unit: '第一公司', name: '示例项目三', rate: 2.5 },
  { unit: '第二公司', name: '示例项目四', rate: 2 },
  { unit: '第二公司', name: '示例项目五', rate: 1.5 },
];

/* 上期（3 月）专项费用：只有开累产值是真正要录的数字 */
const SAFETY_MAR = [
  { unit: '第一公司', proj: '示例项目一', rate: 2, cum: 128600000, opening: 2320000 },
  { unit: '第一公司', proj: '示例项目二', rate: 2, cum: 43800000, opening: 786000 },
  { unit: '第一公司', proj: '示例项目三', rate: 2.5, cum: 91200000, opening: 2180000 },
  { unit: '第二公司', proj: '示例项目四', rate: 2, cum: 56400000, opening: 1050000 },
  { unit: '第二公司', proj: '示例项目五', rate: 1.5, cum: 22700000, opening: 318000 },
];

const UNION_MAR = [
  { unit: '第一公司', wage: 9860000, prevWage: 6540000, u0: 130800, e0: 98100 },
  { unit: '第二公司', wage: 5420000, prevWage: 3610000, u0: 72200, e0: 54150 },
  { unit: '设备物资公司', wage: 1980000, prevWage: 1320000, u0: 26400, e0: 19800 },
];

/* 设施：一半是期初接续（从旧账切过来），一半是本年新建。
   设施类别 / 资产类型 只能用 lib/schema.js 里声明的选项。
   期初已摊数取的是旧 Excel 台账截至 2026-03 的开累数——正好等于按月推下来的值，
   这样切过来之后前后口径能对上，也方便核对。 */
const TFA = [
  // 461700 ÷ 36 = 12825/月；2024-07 起至 2026-03 共 21 期 → 269325
  { name: '项目部办公板房（A3 标）', unit: '第一公司', cat: '房屋类设施', cost: 486000, months: 36,
    start: '2024-07-01', openAmt: 269325, openYm: '2026-03' },
  // 1197000 ÷ 48 = 24937.50/月；2024-01 起至 2026-03 共 27 期 → 673312.50
  { name: '工人生活区宿舍', unit: '第一公司', cat: '房屋类设施', cost: 1260000, months: 48,
    start: '2024-01-01', openAmt: 673312.5, openYm: '2026-03' },
  { name: '厂区道路及硬化', unit: '第一公司', cat: '构筑物类设施', cost: 830000, months: 24,
    start: '2026-01-01', book: '2026-01-01' },
  { name: '型材加工棚', unit: '第二公司', cat: '构筑物类设施', cost: 268000, months: 30,
    start: '2026-02-01', book: '2026-03-01' },
  { name: '临时围挡（示例段）', unit: '第二公司', cat: '其他设施', cost: 96000, months: 12,
    start: '2026-03-01', book: '2026-03-01' },
];

const ASSETS = [
  // 1026000 ÷ 120 = 8550/月；2021-05 起至 2026-03 共 59 期 → 504450
  { name: '轮式挖掘机', unit: '设备物资公司', type: '机械设备', cost: 1080000, years: 10,
    start: '2021-05-01', openAmt: 504450, openYm: '2026-03' },
  // 589000 ÷ 120 = 4908.33/月；2022-09 起至 2026-03 共 43 期 → 211058.19
  { name: '装载机 B50', unit: '设备物资公司', type: '机械设备', cost: 620000, years: 10,
    start: '2022-09-01', openAmt: 211058.19, openYm: '2026-03' },
  { name: '龙门吊 10t', unit: '第一公司', type: '机械设备', cost: 456000, years: 8,
    start: '2025-10-01' },
  { name: '办公电脑一批', unit: '第一公司', type: '电子设备', cost: 86000, years: 5, start: '2026-01-01' },
];

const LVC = [
  { unit: '第一公司', name: '安全帽', spec: 'ABS 红/白', uom: '个', qty: 320, price: 28.5, voucher: '记-2026-03-018' },
  { unit: '第一公司', name: '劳保工作服', spec: '春秋款', uom: '套', qty: 260, price: 168, voucher: '记-2026-03-018' },
  { unit: '第一公司', name: '反光背心', spec: '荧光黄', uom: '件', qty: 300, price: 22, voucher: '记-2026-03-019' },
  { unit: '第二公司', name: '安全绳', spec: '直径 16mm', uom: '根', qty: 45, price: 235, voucher: '记-2026-03-024' },
  { unit: '第二公司', name: '灭火器', spec: '4kg 干粉', uom: '个', qty: 60, price: 96, voucher: '记-2026-03-024' },
];

const BADDEBT = [
  { unit: '第一公司', subject: '应收账款', party: '合作单位B', date: '2026-03-31', bal: 18600000, rate: 5 },
  { unit: '第一公司', subject: '其他应收款', party: '某劳务外包队', date: '2026-03-31', bal: 2360000, rate: 10 },
  { unit: '第二公司', subject: '应收账款', party: '合作单位C', date: '2026-03-31', bal: 9800000, rate: 5 },
];

async function seed() {
  await api('/api/login', { method: 'POST', body: ADMIN });
  await api('/api/password', { method: 'POST', body: { currentPassword: ADMIN.password, newPassword: NEW_PWD } });
  await api('/api/login', { method: 'POST', body: { username: ADMIN.username, password: NEW_PWD } });

  console.log('[demo] 建立单位 / 项目受控清单…');
  for (const name of UNITS) await api('/api/master/units', { method: 'POST', body: { name } });
  for (const p of PROJECTS) await api('/api/master/projects', { method: 'POST', body: p });

  console.log('[demo] 写入上期（2026-03）专项费用与工会经费…');
  await api('/api/period', { method: 'POST', body: { period: '2026-03' } });
  for (const s of SAFETY_MAR) {
    await api('/api/modules/levy/import', {
      method: 'POST',
      body: {
        rows: [{
          单位: { text: s.unit },
          项目名称: { text: s.proj },
          会计期间: { date: '2026-03-01' },
          '累计产值(元)': { number: s.cum },
          '计提比例(%)': { number: s.rate },
          // 接旧账的一次性种子：只对最早一期生效
          '上期累计产值(元)': { number: Math.round(s.cum * 0.92) },
          '期初已计提(元)': { number: s.opening },
        }],
      },
    });
  }
  for (const u of UNION_MAR) {
    await api('/api/modules/union/import', {
      method: 'POST',
      body: {
        rows: [{
          单位: { text: u.unit },
          会计期间: { date: '2026-03-01' },
          '工资年开累(元)': { number: u.wage },
          '上期工资年开累(元)': { number: u.prevWage },
          '工会经费比例(%)': { number: 2 },
          '职工教育经费比例(%)': { number: 1.5 },
          '工会期初已计提(元)': { number: u.u0 },
          '教育期初已计提(元)': { number: u.e0 },
        }],
      },
    });
  }

  console.log('[demo] 写入设施（含期初接续）…');
  for (const t of TFA) {
    const props = {
      设施名称: { text: t.name },
      单位: { text: t.unit },
      设施类别: { select: t.cat },
      摊销方法: { select: '直线法' },
      '原值(元)': { number: t.cost },
      '残值率(%)': { number: 5 },
      '摊销期限(月)': { number: t.months },
      启用日期: { date: t.start },
      状态: { select: '使用中' },
    };
    if (t.book) props['入账日期'] = { date: t.book };
    if (t.openAmt) {
      props['期初已摊销(元)'] = { number: t.openAmt };
      props['期初截止期间'] = { date: `${t.openYm}-01` };
      props['备注'] = { text: '旧账接续：期初已摊数据来自原 Excel 台账' };
    }
    await api('/api/modules/facility/import', { method: 'POST', body: { rows: [props] } });
  }

  console.log('[demo] 写入固定资产（含期初接续）…');
  for (const a of ASSETS) {
    const props = {
      资产名称: { text: a.name },
      单位: { text: a.unit },
      资产类型: { select: a.type },
      '原值(元)': { number: a.cost },
      '残值率(%)': { number: 5 },
      '预计使用年限(年)': { number: a.years },
      启用日期: { date: a.start },
      状态: { select: '使用中' },
    };
    if (a.openAmt) {
      props['期初已折旧(元)'] = { number: a.openAmt };
      props['期初截止期间'] = { date: `${a.openYm}-01` };
      props['备注'] = { text: '旧账接续' };
    }
    await api('/api/modules/asset/import', { method: 'POST', body: { rows: [props] } });
  }

  console.log('[demo] 写入低值易耗品与减值准备…');
  for (const l of LVC) {
    await api('/api/modules/lvc/import', {
      method: 'POST',
      body: {
        rows: [{
          单位: { text: l.unit },
          资产名称: { text: l.name },
          规格型号: { text: l.spec },
          计量单位: { text: l.uom },
          凭证号: { text: l.voucher },
          入账月份: { date: '2026-03-01' },
          开票日期: { date: '2026-03-18' },
          数量: { number: l.qty },
          '单价(元)': { number: l.price },
        }],
      },
    });
  }
  for (const b of BADDEBT) {
    await api('/api/modules/baddebt/import', {
      method: 'POST',
      body: {
        rows: [{
          单位: { text: b.unit },
          科目名称: { text: b.subject },
          往来单位名称: { text: b.party },
          入账日期: { date: b.date },
          '科目余额(元)': { number: b.bal },
          '计提比例(%)': { number: b.rate },
        }],
      },
    });
  }

  // 上期已核对完毕 → 结账；本期（4 月）留空，等着用结转开始本期
  console.log('[demo] 3 月结账，期间切到 2026-04（本期待结转）…');
  for (const m of ['levy', 'union']) {
    await api('/api/closures', { method: 'POST', body: { module: m, period: '2026-03', closed: true } });
  }
  await api('/api/period', { method: 'POST', body: { period: '2026-04' } });

  // 再开一个记账员账号，方便看角色差异
  const acc = await api('/api/users', {
    method: 'POST',
    body: { username: 'kuaiji', displayName: '张会计', role: 'accountant' },
  });
  return acc.initialPassword;
}

try {
  await waitReady();
  let accPwd = null;
  if (FRESH) accPwd = await seed();
  else console.log('[demo] 已有 data-demo 数据，跳过预置（想重来加 --reset）');

  const line = '='.repeat(56);
  console.log(`\n${line}`);
  console.log('  演示实例已就绪');
  console.log(`  地址：${BASE}`);
  console.log(`  管理员：${ADMIN.username} / ${NEW_PWD}`);
  if (accPwd) console.log(`  记账员：kuaiji / ${accPwd}`);
  console.log('');
  console.log('  当前状态：3 月已录完并结账，期间已切到 4 月（空的）。');
  console.log('  建议按这个顺序看：');
  console.log('    1) 「⋯ → 本月结转」→ 上期 5 条项目名册整份列出，只填新开累数');
  console.log('    2) 「⋯ → Excel 粘贴导入」→ 粘一块单元格，看逐行预检');
  console.log('    3) 「⋯ → 单位/项目清单」→ 试一次改名，看历史台账被连带改写');
  console.log('    4) 「设施摊销」「固定资产折旧」→ 期初接续的记录不用补历史');
  console.log('');
  console.log('  数据目录：server/data-demo（与正式账套隔离，删掉即重来）');
  console.log('  停止：Ctrl+C');
  console.log(`${line}\n`);
} catch (err) {
  console.error('[demo] 预置失败：', err.message);
  process.exitCode = 1;
} finally {
  // 预置阶段失败也必须收回服务，避免遗留一个指向半成品数据目录的进程。
  if (process.exitCode) cleanup();
}
