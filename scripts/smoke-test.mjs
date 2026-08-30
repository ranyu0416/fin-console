#!/usr/bin/env node
/**
 * 端到端自检：跑一遍关键流程，覆盖鉴权、CRUD、字段校验、结账只读、只读账号、
 * 期间共享、导入、审计、备份、静态资源。
 *
 * 两种用法：
 *   1) 自己拉起服务（默认）：node scripts/smoke-test.mjs
 *   2) 连已在跑的服务：
 *        FIN_SMOKE_BASE=http://127.0.0.1:8787 FIN_SMOKE_USER=admin FIN_SMOKE_PASSWORD=xxx \
 *        node scripts/smoke-test.mjs
 *      外部实例会写入测试数据；非本机地址必须设置 FIN_SMOKE_ALLOW_MUTATION=1。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(HERE, '..');
const EXTERNAL_BASE = process.env.FIN_SMOKE_BASE || '';
const PORT = 18787 + Math.floor(Math.random() * 400);
const BASE = EXTERNAL_BASE || `http://127.0.0.1:${PORT}`;
const ADMIN = {
  username: process.env.FIN_SMOKE_USER || 'admin',
  password: process.env.FIN_SMOKE_PASSWORD || 'Smoke12345',
};
const EXPECT_MUST_CHANGE = !EXTERNAL_BASE;
/*
 * 服务端现在会在口令未修改前拒绝一切业务操作（只放行改口令与查看自身信息）。
 * 以前 mustChange 只是前端弹窗，未改口令的账号可以照常写台账甚至导出整套账，
 * 而初始口令是打印在控制台、写在部署脚本里的。
 * 所以自检脚本必须先完成改密流程，后面的用例才代表真实使用路径。
 */
const ADMIN_PWD_AFTER = 'Smoke12345Next';
const EXPECT_ORG = process.env.FIN_SMOKE_ORG || (EXTERNAL_BASE ? null : '自检集团');
let DATA_DIR = '';

if (EXTERNAL_BASE) {
  let host = '';
  try {
    host = new URL(EXTERNAL_BASE).hostname.toLowerCase();
  } catch {
    console.error(`错误：FIN_SMOKE_BASE 不是有效地址：${EXTERNAL_BASE}`);
    process.exit(1);
  }
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  // 外部模式会执行写操作；只允许本机默认放行，避免一条环境变量误伤正式账套。
  if (!isLoopback && process.env.FIN_SMOKE_ALLOW_MUTATION !== '1') {
    console.error('错误：外部 smoke 测试会写入和删除数据。非本机地址必须显式设置 FIN_SMOKE_ALLOW_MUTATION=1 才能继续。');
    process.exit(1);
  }
}

// 与服务端 config.loginMaxAttempts 默认值保持一致；限流用例据此决定尝试次数
const config_loginMax = Number(process.env.FIN_LOGIN_MAX_ATTEMPTS || 8);

let passed = 0;
const failures = [];

function ok(name) {
  passed += 1;
  console.log(`  ✓ ${name}`);
}
function fail(name, detail) {
  failures.push(`${name}：${detail}`);
  console.log(`  ✗ ${name} — ${detail}`);
}
async function check(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    fail(name, err.message);
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/* ---------- 极简 cookie 会话客户端 ---------- */
function makeClient() {
  const jar = new Map();
  return async function request(path, { method = 'GET', body, headers = {} } = {}) {
    const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    const init = {
      method,
      headers: {
        Accept: 'application/json',
        Origin: BASE,
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
    };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const resp = await fetch(BASE + path, init);
    for (const raw of resp.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (!value) jar.delete(name);
      else jar.set(name, value);
    }
    const ct = resp.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await resp.json() : await resp.text();
    return { status: resp.status, data, headers: resp.headers };
  };
}

/* ---------- 启动服务（外部实例模式下跳过） ---------- */
let child = null;
let serverLog = '';

if (!EXTERNAL_BASE) {
  DATA_DIR = mkdtempSync(join(tmpdir(), 'fin-smoke-'));
  child = spawn(process.execPath, ['server.js'], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      FIN_HOST: '127.0.0.1',
      FIN_PORT: String(PORT),
      FIN_DATA_DIR: DATA_DIR,
      FIN_ADMIN_USER: ADMIN.username,
      FIN_ADMIN_PASSWORD: ADMIN.password,
      FIN_BACKUP_INTERVAL_HOURS: '0',
      FIN_ORG_NAME: '自检集团',
    },
    // 捕获后再透传，启动失败时摘要才能保留服务端真实诊断。
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const [stream, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    stream.on('data', (chunk) => {
      const text = chunk.toString();
      serverLog += text;
      output.write(text);
    });
  }
}

async function waitReady(timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child && child.exitCode !== null) throw new Error(`服务器提前退出（code ${child.exitCode}）：\n${serverLog}`);
    try {
      const resp = await fetch(`${BASE}/api/health`);
      if (resp.ok) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`服务器 ${timeoutMs}ms 内未就绪：\n${serverLog}`);
}

function cleanup() {
  if (child) {
    try { child.kill(); } catch { /* 已退出 */ }
  }
  if (DATA_DIR) {
    setTimeout(() => {
      try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 文件占用，交给系统清理 tmp */ }
    }, 300);
  }
}

try {
  console.log(`\n[smoke] 服务地址 ${BASE}${DATA_DIR ? `（临时数据目录 ${DATA_DIR}）` : '（连接已运行的实例）'}\n`);
  await waitReady();

  const admin = makeClient();
  const anon = makeClient();

  console.log('鉴权：');
  await check('未登录访问台账数据被拒绝（401）', async () => {
    const r = await anon('/api/modules/facility/records');
    assert(r.status === 401, `期望 401，实际 ${r.status}`);
  });
  await check('未登录时 /api/me 返回未认证', async () => {
    const r = await anon('/api/me');
    assert(r.status === 200 && r.data.authenticated === false, JSON.stringify(r.data));
  });
  await check('错误口令登录失败（401）', async () => {
    const r = await anon('/api/login', { method: 'POST', body: { username: ADMIN.username, password: 'wrong-pass-1' } });
    assert(r.status === 401, `期望 401，实际 ${r.status}`);
  });
  await check('跨站写请求被拒绝（403）', async () => {
    const r = await anon('/api/login', {
      method: 'POST',
      body: ADMIN,
      headers: { Origin: 'http://evil.example' },
    });
    assert(r.status === 403, `期望 403，实际 ${r.status}`);
  });

  let me = null;
  await check('管理员登录成功并拿到会话 Cookie', async () => {
    const r = await admin('/api/login', { method: 'POST', body: ADMIN });
    assert(r.status === 200, `HTTP ${r.status}: ${JSON.stringify(r.data)}`);
    assert(r.data.user.role === 'admin', '角色应为 admin');
    if (EXPECT_MUST_CHANGE) assert(r.data.user.mustChange === true, '首启动管理员应要求改密');
    me = r.data;
  });
  await check('未改初始口令时业务操作被拒（403 must_change_password）', async () => {
    if (!EXPECT_MUST_CHANGE) return;   // 外部实例的管理员早就改过密了
    const w = await admin('/api/modules/facility/records', { method: 'POST', body: { properties: { 设施名称: { text: 'x' } } } });
    assert(w.status === 403 && w.data.code === 'must_change_password', `写入 ${w.status} ${JSON.stringify(w.data)}`);
    const e = await admin('/api/export');
    assert(e.status === 403, `导出应被拒，实际 ${e.status}`);
  });
  await check('管理员完成首登改密后恢复全部权限', async () => {
    if (!EXPECT_MUST_CHANGE) return;
    const ch = await admin('/api/password', {
      method: 'POST',
      body: { currentPassword: ADMIN.password, newPassword: ADMIN_PWD_AFTER },
    });
    assert(ch.status === 200, JSON.stringify(ch.data));
    // 改密会吊销全部会话，必须重新登录
    const again = await admin('/api/login', { method: 'POST', body: { username: ADMIN.username, password: ADMIN_PWD_AFTER } });
    assert(again.status === 200 && again.data.user.mustChange === false, JSON.stringify(again.data.user));
    me = again.data;
    const e = await admin('/api/export');
    assert(e.status === 200, `改密后导出应成功，实际 ${e.status}`);
  });
  await check('登录后 orgName 来自服务端配置', async () => {
    if (EXPECT_ORG === null) {
      assert(typeof me.orgName === 'string', 'orgName 应为字符串');
      return;
    }
    assert(me.orgName === EXPECT_ORG, `实际 ${me.orgName}`);
  });

  console.log('\n模块与字段：');
  /*
   * 六个核心模块必须存在，但不断言「一共只有六个」。
   * 断言总数会让「新增一个模块」这件正常的事直接把自检打成失败，
   * 于是下一个人要么改断言要么跳过测试——两条路都比现在差。
   * 核心模块缺失才是真问题，这里只查它们在不在。
   */
  const CORE_MODULES = ['asset', 'baddebt', 'lvc', 'levy', 'facility', 'union'];
  let serverModuleKeys = CORE_MODULES.slice();
  await check('六个核心模块 schema 齐全', async () => {
    const r = await admin('/api/schema');
    assert(r.status === 200, `HTTP ${r.status}`);
    const keys = r.data.modules.map((m) => m.databaseId).sort();
    serverModuleKeys = keys;
    const missing = CORE_MODULES.filter((k) => !keys.includes(k));
    assert(missing.length === 0, `缺少模块 ${missing.join(',')}（实际 ${keys.join(',')}）`);
  });
  await check('历史 dbId 也能解析到模块', async () => {
    const r = await admin('/api/modules/ImZmbLHPiJNk65y1b28JUi/schema');
    assert(r.status === 200 && r.data.databaseId === 'facility', JSON.stringify(r.data).slice(0, 120));
  });
  await check('选择型字段带出选项', async () => {
    const r = await admin('/api/modules/facility/schema');
    const status = r.data.properties.find((p) => p.name === '状态');
    assert(status && status.type === 'select', '状态字段应为 select');
    assert(status.config.options.includes('已摊完'), JSON.stringify(status.config.options));
  });

  console.log('\n台账 CRUD：');
  let facilityId = null;
  await check('新增设施记录', async () => {
    const r = await admin('/api/modules/facility/records', {
      method: 'POST',
      body: {
        properties: {
          设施名称: { text: '项目部办公板房' },
          单位: { text: '一分公司' },
          设施类别: { select: '房屋类设施' },
          摊销方法: { select: '直线法' },
          '原值(元)': { number: 240000 },
          '残值率(%)': { number: 5 },
          启用日期: { date: '2026-01-01' },
          入账日期: { date: '2026-01-01' },
          '摊销期限(月)': { number: 24 },
          状态: { select: '使用中' },
        },
      },
    });
    assert(r.status === 201, `HTTP ${r.status}: ${JSON.stringify(r.data)}`);
    assert(r.data.record['原值(元)'] === 240000, '原值应回读为数字 240000');
    facilityId = r.data.record._id;
  });
  await check('查询能读回记录且带审计元信息', async () => {
    const r = await admin('/api/modules/facility/records');
    const rec = r.data.results.find((x) => x._id === facilityId);
    assert(rec, `未能读回刚写入的记录（共 ${r.data.results.length} 条）`);
    assert(rec._createdBy === ADMIN.username, `创建人应为 ${ADMIN.username}，实际 ${rec._createdBy}`);
    assert(rec['设施名称'] === '项目部办公板房', rec['设施名称']);
  });
  await check('修改记录后版本号递增', async () => {
    const r = await admin(`/api/modules/facility/records/${encodeURIComponent(facilityId)}`, {
      method: 'PATCH',
      body: { properties: { '原值(元)': { number: 260000 }, 备注: { text: '追加装修费' } } },
    });
    assert(r.status === 200, `HTTP ${r.status}: ${JSON.stringify(r.data)}`);
    assert(r.data.record['原值(元)'] === 260000, '原值应更新');
    assert(r.data.record['设施名称'] === '项目部办公板房', '未提交的字段应保留');
    assert(r.data.record._rev === 2, `版本应为 2，实际 ${r.data.record._rev}`);
  });
  await check('非法选项被拒绝（400）', async () => {
    const r = await admin('/api/modules/facility/records', {
      method: 'POST',
      body: { properties: { 设施名称: { text: 'x' }, 状态: { select: '不存在的状态' } } },
    });
    assert(r.status === 400, `期望 400，实际 ${r.status}`);
    assert(String(r.data.error).includes('状态'), r.data.error);
  });
  await check('非数字金额被拒绝（400）', async () => {
    const r = await admin('/api/modules/facility/records', {
      method: 'POST',
      body: { properties: { 设施名称: { text: 'x' }, '原值(元)': { number: '不是数字' } } },
    });
    assert(r.status === 400, `期望 400，实际 ${r.status}`);
  });
  await check('未声明字段被忽略而非写入', async () => {
    const r = await admin('/api/modules/facility/records', {
      method: 'POST',
      body: { properties: { 设施名称: { text: '临时围墙' }, 单位: { text: '二分公司' }, 注入字段: { text: 'x' } } },
    });
    assert(r.status === 201, `HTTP ${r.status}: ${JSON.stringify(r.data)}`);
    assert(r.data.ignoredFields.includes('注入字段'), JSON.stringify(r.data.ignoredFields));
    assert(!('注入字段' in r.data.record), '未声明字段不应落库');
    await admin(`/api/modules/facility/records/${encodeURIComponent(r.data.record._id)}`, { method: 'DELETE' });
  });
  await check('全角数字与千分位金额自动归一', async () => {
    const r = await admin('/api/modules/facility/records', {
      method: 'POST',
      body: { properties: { 设施名称: { text: '归一测试' }, '原值(元)': { number: '12,500' } } },
    });
    assert(r.status === 201, JSON.stringify(r.data));
    assert(r.data.record['原值(元)'] === 12500, `实际 ${r.data.record['原值(元)']}`);
    await admin(`/api/modules/facility/records/${encodeURIComponent(r.data.record._id)}`, { method: 'DELETE' });
  });

  console.log('\n期间与结账：');
  await check('推进账套期间（全局共享）', async () => {
    const r = await admin('/api/period', { method: 'POST', body: { period: '2026-03' } });
    assert(r.status === 200 && r.data.workPeriod === '2026-03', JSON.stringify(r.data));
  });
  await check('非法期间格式被拒绝（400）', async () => {
    const r = await admin('/api/period', { method: 'POST', body: { period: '2026/3' } });
    assert(r.status === 400, `期望 400，实际 ${r.status}`);
  });
  await check('不存在的月份被拒绝（2026-13 / 2026-00）', async () => {
    // 只校验 /^\d{4}-\d{2}$/ 会放过这两个值，它们能一路写进 settings 成为「当前期间」，
    // 还能被拼成 2026-13-01 存进日期字段
    for (const bad of ['2026-13', '2026-00', '2026-99']) {
      const r = await admin('/api/period', { method: 'POST', body: { period: bad } });
      assert(r.status === 400, `${bad} 期望 400，实际 ${r.status}`);
    }
  });
  await check('不存在的日期被拒绝（2026-02-31）', async () => {
    // Date.parse('2026-02-31') 不报错（滚到 3 月 3 日），必须回读三个分量比对
    const r = await admin('/api/modules/levy/records', {
      method: 'POST',
      body: { properties: { 单位: { text: '一分公司' }, 会计期间: { date: '2026-02-31' }, '累计产值(元)': { number: 1 } } },
    });
    assert(r.status === 400, `期望 400，实际 ${r.status}：${JSON.stringify(r.data).slice(0, 120)}`);
  });
  let levyId = null;
  await check('按期间新增专项费用记录', async () => {
    const r = await admin('/api/modules/levy/records', {
      method: 'POST',
      body: {
        properties: {
          单位: { text: '一分公司' },
          项目名称: { text: 'XX 道路项目' },
          会计期间: { date: '2026-03-01' },
          '累计产值(元)': { number: 5000000 },
          '计提比例(%)': { number: 2 },
        },
      },
    });
    assert(r.status === 201, JSON.stringify(r.data));
    levyId = r.data.record._id;
  });
  await check('结账后该模块该期间禁止修改（409）', async () => {
    const c = await admin('/api/closures', { method: 'POST', body: { module: 'levy', period: '2026-03', closed: true } });
    assert(c.status === 200, `结账失败 HTTP ${c.status}`);
    const r = await admin(`/api/modules/levy/records/${encodeURIComponent(levyId)}`, {
      method: 'PATCH',
      body: { properties: { '计提比例(%)': { number: 3 } } },
    });
    assert(r.status === 409, `期望 409，实际 ${r.status}: ${JSON.stringify(r.data)}`);
    assert(String(r.data.error).includes('已结账'), r.data.error);
  });
  await check('结账后禁止删除该期间记录（409）', async () => {
    const r = await admin(`/api/modules/levy/records/${encodeURIComponent(levyId)}`, { method: 'DELETE' });
    assert(r.status === 409, `期望 409，实际 ${r.status}`);
  });
  await check('结账后禁止在该期间新增（409）', async () => {
    const r = await admin('/api/modules/levy/records', {
      method: 'POST',
      body: { properties: { 单位: { text: '一分公司' }, 项目名称: { text: '追加' }, 会计期间: { date: '2026-03-01' } } },
    });
    assert(r.status === 409, `期望 409，实际 ${r.status}`);
  });
  await check('结账锁不影响其它期间', async () => {
    const r = await admin('/api/modules/levy/records', {
      method: 'POST',
      body: {
        properties: {
          单位: { text: '一分公司' },
          项目名称: { text: 'XX 道路项目' },
          会计期间: { date: '2026-04-01' },
          '累计产值(元)': { number: 6000000 },
          '计提比例(%)': { number: 2 },
        },
      },
    });
    assert(r.status === 201, `HTTP ${r.status}: ${JSON.stringify(r.data)}`);
    await admin(`/api/modules/levy/records/${encodeURIComponent(r.data.record._id)}`, { method: 'DELETE' });
  });
  await check('结账锁不影响其它模块', async () => {
    const r = await admin(`/api/modules/facility/records/${encodeURIComponent(facilityId)}`, {
      method: 'PATCH',
      body: { properties: { 备注: { text: '结账锁隔离验证' } } },
    });
    assert(r.status === 200, `HTTP ${r.status}: ${JSON.stringify(r.data)}`);
  });
  await check('重开期间后恢复可写', async () => {
    const c = await admin('/api/closures', { method: 'POST', body: { module: 'levy', period: '2026-03', closed: false } });
    assert(c.status === 200 && c.data.closures.length === 0, JSON.stringify(c.data));
    const r = await admin(`/api/modules/levy/records/${encodeURIComponent(levyId)}`, {
      method: 'PATCH',
      body: { properties: { '计提比例(%)': { number: 3 } } },
    });
    assert(r.status === 200, `HTTP ${r.status}: ${JSON.stringify(r.data)}`);
    assert(r.data.record['计提比例(%)'] === 3, '比例应更新为 3');
  });

  console.log('\n多用户与权限：');
  const VIEWER_NAME = `viewer_${Date.now().toString(36)}`;
  const VIEWER_PWD_NEW = 'Viewer12345';
  let viewerPwd = null;
  await check('管理员创建只读账号', async () => {
    const r = await admin('/api/users', {
      method: 'POST',
      body: { username: VIEWER_NAME, displayName: '审阅人', role: 'viewer' },
    });
    assert(r.status === 201, JSON.stringify(r.data));
    assert(r.data.initialPassword, '应返回自动生成的初始口令');
    viewerPwd = r.data.initialPassword;
  });
  const viewer = makeClient();
  await check('只读账号首登被要求改密，改密后可登录', async () => {
    const first = await viewer('/api/login', { method: 'POST', body: { username: VIEWER_NAME, password: viewerPwd } });
    assert(first.status === 200 && first.data.user.mustChange === true, JSON.stringify(first.data));
    const ch = await viewer('/api/password', {
      method: 'POST',
      body: { currentPassword: viewerPwd, newPassword: VIEWER_PWD_NEW },
    });
    assert(ch.status === 200, JSON.stringify(ch.data));
    const again = await viewer('/api/login', { method: 'POST', body: { username: VIEWER_NAME, password: VIEWER_PWD_NEW } });
    assert(again.status === 200 && again.data.can.write === false, JSON.stringify(again.data.can));
  });
  await check('只读账号能查询数据', async () => {
    const r = await viewer('/api/modules/facility/records');
    assert(r.status === 200 && r.data.results.length >= 1, JSON.stringify(r.data).slice(0, 120));
  });
  await check('只读账号写入被拒绝（403）', async () => {
    const r = await viewer('/api/modules/facility/records', { method: 'POST', body: { properties: { 设施名称: { text: 'x' } } } });
    assert(r.status === 403, `期望 403，实际 ${r.status}`);
  });
  await check('只读账号结账被拒绝（403）', async () => {
    const r = await viewer('/api/closures', { method: 'POST', body: { module: 'facility', period: '2026-03', closed: true } });
    assert(r.status === 403, `期望 403，实际 ${r.status}`);
  });
  await check('只读账号访问账号管理被拒绝（403）', async () => {
    const r = await viewer('/api/users');
    assert(r.status === 403, `期望 403，实际 ${r.status}`);
  });
  await check('弱口令改密被拒绝（400）', async () => {
    const r = await viewer('/api/password', { method: 'POST', body: { currentPassword: VIEWER_PWD_NEW, newPassword: '123456' } });
    assert(r.status === 400, `期望 400，实际 ${r.status}`);
  });
  await check('两个账号看到同一个账套期间（全局共享）', async () => {
    const a = await admin('/api/period');
    const v = await viewer('/api/period');
    assert(a.data.workPeriod === v.data.workPeriod, `${a.data.workPeriod} vs ${v.data.workPeriod}`);
    assert(a.data.workPeriod === '2026-03', a.data.workPeriod);
  });
  await check('只读账号不能推进账套期间（403）', async () => {
    // 这曾是一个真实漏洞：/api/period 只校验登录不校验权限，
    // 任何只读账号都能把全公司的当前会计期间改成任意月份
    const r = await viewer('/api/period', { method: 'POST', body: { period: '1999-01' } });
    assert(r.status === 403, `期望 403，实际 ${r.status}`);
    const after = await admin('/api/period');
    assert(after.data.workPeriod === '2026-03', `账套期间被改动了：${after.data.workPeriod}`);
  });
  await check('只读账号可以改自己的查看期间，且不影响别人', async () => {
    const set = await viewer('/api/view-period', { method: 'POST', body: { period: '2026-01' } });
    assert(set.status === 200 && set.data.viewPeriod === '2026-01', JSON.stringify(set.data));
    const v = await viewer('/api/period');
    const a = await admin('/api/period');
    assert(v.data.viewPeriod === '2026-01', `只读账号自己的视图期间应为 2026-01，实际 ${v.data.viewPeriod}`);
    assert(a.data.viewPeriod === '2026-03', `管理员的视图期间不该被带偏，实际 ${a.data.viewPeriod}`);
    assert(v.data.workPeriod === '2026-03', `账套期间不该变，实际 ${v.data.workPeriod}`);
  });
  await check('重置查看期间后回到跟随账套期间', async () => {
    const r = await viewer('/api/view-period', { method: 'DELETE' });
    assert(r.status === 200 && r.data.viewPeriod === '2026-03', JSON.stringify(r.data));
  });
  await check('查看期间同样拒绝不存在的月份', async () => {
    const r = await viewer('/api/view-period', { method: 'POST', body: { period: '2026-13' } });
    assert(r.status === 400, `期望 400，实际 ${r.status}`);
  });

  console.log('\n批量与运维：');
  await check('批量导入低值易耗品', async () => {
    const r = await admin('/api/modules/lvc/import', {
      method: 'POST',
      body: {
        rows: [
          { 单位: '一分公司', 资产名称: '安全帽', 入账月份: '2026-03-01', 数量: 100, '单价(元)': 25, 计量单位: '个' },
          { 单位: '一分公司', 资产名称: '工作服', 入账月份: '2026-03-01', 数量: 60, '单价(元)': 120, 计量单位: '套' },
          { 资产名称: '坏数据', 数量: '不是数字' },
        ],
        replace: false,
      },
    });
    assert(r.status === 200, JSON.stringify(r.data));
    assert(r.data.inserted === 2, `应导入 2 条，实际 ${r.data.inserted}`);
    assert(r.data.skipped === 1, `应跳过 1 条，实际 ${r.data.skipped}`);
  });
  await check('总览接口默认只返回汇总（不再推送全部明细）', async () => {
    const r = await admin('/api/overview');
    assert(r.status === 200, `HTTP ${r.status}`);
    assert(Object.keys(r.data.summaries).length === serverModuleKeys.length, Object.keys(r.data.summaries || {}).join(','));
    assert(r.data.summaries.lvc.total >= 2, `lvc 汇总应至少 2 条，实际 ${r.data.summaries.lvc.total}`);
    // 默认不带明细：300 条数据的明细响应是 98.8 KB，而页面只需要几个合计数
    assert(r.data.modules === undefined, '默认响应不应包含 modules 明细');
  });
  await check('总览接口 ?detail=1 仍可取全部明细', async () => {
    const r = await admin('/api/overview?detail=1');
    assert(r.status === 200, `HTTP ${r.status}`);
    assert(Object.keys(r.data.modules).length === serverModuleKeys.length, Object.keys(r.data.modules).join(','));
    assert(r.data.modules.lvc.length >= 2, `lvc 应至少 2 条，实际 ${r.data.modules.lvc.length}`);
  });
  await check('共享打印列配置可存取', async () => {
    const w = await admin('/api/settings', { method: 'POST', body: { printProfiles: { facility: { print: [0, 1, 2] } } } });
    assert(w.status === 200, JSON.stringify(w.data));
    const r = await viewer('/api/settings');
    assert(JSON.stringify(r.data.printProfiles.facility.print) === '[0,1,2]', JSON.stringify(r.data.printProfiles));
  });
  await check('审计日志记录了写操作', async () => {
    const r = await admin('/api/audit?limit=500');
    const actions = r.data.rows.map((x) => x.action);
    for (const need of ['login.ok', 'record.create', 'record.update', 'period.close', 'period.reopen', 'user.create']) {
      assert(actions.includes(need), `缺少 ${need} 记录`);
    }
  });
  await check('只读账号可以查看操作日志', async () => {
    const r = await viewer('/api/audit?limit=10');
    assert(r.status === 200 && Array.isArray(r.data.rows), JSON.stringify(r.data).slice(0, 100));
  });
  await check('管理员可生成热备份文件', async () => {
    const r = await admin('/api/backup', { method: 'POST' });
    assert(r.status === 200 && r.data.backups.length >= 1, JSON.stringify(r.data).slice(0, 200));
  });
  await check('整套账 JSON 导出包含全部模块', async () => {
    const r = await admin('/api/export');
    const payload = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    assert(Object.keys(payload.modules).length === serverModuleKeys.length, Object.keys(payload.modules).join(','));
    assert(payload.workPeriod === '2026-03', payload.workPeriod);
  });
  await check('导出包含受控清单（否则这份备份不足以重建账套）', async () => {
    // 缺了 org_units / org_projects 的话，恢复出来的记录全是「不在清单里」的名称，
    // 而清单是计提链条的匹配基准，这才是必须一起带走的原因
    const r = await admin('/api/export');
    const payload = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    assert(payload.masterData && Array.isArray(payload.masterData.units), '导出缺少 masterData.units');
    assert(Array.isArray(payload.masterData.projects), '导出缺少 masterData.projects');
    assert(payload.version >= 2, `导出格式版本应 >= 2，实际 ${payload.version}`);
  });
  await check('只读账号不能导出整套账（403）', async () => {
    const r = await viewer('/api/export');
    assert(r.status === 403, `期望 403，实际 ${r.status}`);
  });

  console.log('\n受控清单（单位 / 项目）：');
  await check('清单为空时不拦截录入（新装系统可以直接开始用）', async () => {
    const r = await admin('/api/modules/levy/records', {
      method: 'POST',
      body: {
        properties: {
          单位: { text: '尚未建清单的公司' },
          项目名称: { text: '随手写的项目' },
          会计期间: { date: '2026-05-01' },
          '累计产值(元)': { number: 100 },
        },
      },
    });
    assert(r.status === 201, `期望 201，实际 ${r.status}: ${JSON.stringify(r.data)}`);
    await admin(`/api/modules/levy/records/${encodeURIComponent(r.data.record._id)}`, { method: 'DELETE' });
  });
  await check('管理员添加单位', async () => {
    const r = await admin('/api/master/units', { method: 'POST', body: { name: '一分公司', sort: 1 } });
    assert(r.status === 201, JSON.stringify(r.data));
    assert(r.data.units.some((u) => u.name === '一分公司'), JSON.stringify(r.data.units));
  });
  await check('单位名称自动规范化（全角括号、多余空白）', async () => {
    const r = await admin('/api/master/units', { method: 'POST', body: { name: '  二分公司（南区）  ' } });
    assert(r.status === 201, JSON.stringify(r.data));
    assert(r.data.name === '二分公司(南区)', `实际「${r.data.name}」`);
  });
  await check('重复添加同名单位被拒绝（400）', async () => {
    const r = await admin('/api/master/units', { method: 'POST', body: { name: '一分公司' } });
    assert(r.status === 400, `期望 400，实际 ${r.status}`);
  });
  await check('只读账号不能维护清单（403）', async () => {
    const r = await viewer('/api/master/units', { method: 'POST', body: { name: '三分公司' } });
    assert(r.status === 403, `期望 403，实际 ${r.status}`);
  });
  await check('清单建立后，不在清单里的单位被拒绝（400）', async () => {
    const r = await admin('/api/modules/facility/records', {
      method: 'POST',
      body: { properties: { 设施名称: { text: '野单位设施' }, 单位: { text: '不存在的分公司' } } },
    });
    assert(r.status === 400, `期望 400，实际 ${r.status}: ${JSON.stringify(r.data)}`);
    assert(String(r.data.error).includes('受控清单'), r.data.error);
  });
  let projectId = null;
  await check('添加项目并带出计提比例', async () => {
    const r = await admin('/api/master/projects', {
      method: 'POST',
      body: { unit: '一分公司', name: 'XX 道路项目', rate: 2 },
    });
    assert(r.status === 201, JSON.stringify(r.data));
    const p = r.data.projects.find((x) => x.name === 'XX 道路项目');
    assert(p && p.rate === 2, JSON.stringify(p));
    projectId = p.id;
  });
  await check('项目挂到不存在的单位被拒绝（400）', async () => {
    const r = await admin('/api/master/projects', { method: 'POST', body: { unit: '没有这个公司', name: '某项目' } });
    assert(r.status === 400, `期望 400，实际 ${r.status}`);
  });
  await check('计提比例超出 0～100 被拒绝（400）', async () => {
    const r = await admin('/api/master/projects', { method: 'POST', body: { unit: '一分公司', name: '越界项目', rate: 250 } });
    assert(r.status === 400, `期望 400，实际 ${r.status}`);
  });
  await check('清单里没有的项目被拒绝（400）', async () => {
    const r = await admin('/api/modules/levy/records', {
      method: 'POST',
      body: {
        properties: {
          单位: { text: '一分公司' },
          项目名称: { text: '清单外的项目' },
          会计期间: { date: '2026-05-01' },
          '累计产值(元)': { number: 100 },
        },
      },
    });
    assert(r.status === 400, `期望 400，实际 ${r.status}: ${JSON.stringify(r.data)}`);
  });
  await check('单位改名连带改写历史台账（计提链条不断）', async () => {
    const before = await admin('/api/modules/facility/records');
    const affected = before.data.results.filter((x) => x['单位'] === '一分公司').length;
    const r = await admin('/api/master/units/' + encodeURIComponent('一分公司'), {
      method: 'PATCH',
      body: { newName: '第一公司' },
    });
    assert(r.status === 200, JSON.stringify(r.data));
    const after = await admin('/api/modules/facility/records');
    assert(after.data.results.every((x) => x['单位'] !== '一分公司'), '仍有记录留在旧名下');
    assert(r.data.records >= affected, `应改写至少 ${affected} 条，实际 ${r.data.records}`);
    // 项目也跟着换了单位归属
    const proj = await admin('/api/master/projects?unit=' + encodeURIComponent('第一公司'));
    assert(proj.data.projects.some((p) => p.name === 'XX 道路项目'), JSON.stringify(proj.data.projects));
  });
  await check('项目改名连带改写专项费用台账', async () => {
    const r = await admin(`/api/master/projects/${projectId}`, { method: 'PATCH', body: { newName: 'XX 综合项目' } });
    assert(r.status === 200, JSON.stringify(r.data));
    const recs = await admin('/api/modules/levy/records');
    assert(recs.data.results.every((x) => x['项目名称'] !== 'XX 道路项目'), '仍有记录留在旧项目名下');
  });
  await check('单位下还有在用项目时不能停用（400）', async () => {
    const r = await admin('/api/master/units/' + encodeURIComponent('第一公司'), { method: 'DELETE' });
    assert(r.status === 400, `期望 400，实际 ${r.status}: ${JSON.stringify(r.data)}`);
    assert(String(r.data.error).includes('在用项目'), r.data.error);
  });
  await check('关闭强制开关后，清单外名称可以录入', async () => {
    const off = await admin('/api/master/strict', { method: 'POST', body: { strict: false } });
    assert(off.status === 200 && off.data.strict === false, JSON.stringify(off.data));
    const r = await admin('/api/modules/facility/records', {
      method: 'POST',
      body: { properties: { 设施名称: { text: '临时录入' }, 单位: { text: '临时单位' } } },
    });
    assert(r.status === 201, `期望 201，实际 ${r.status}: ${JSON.stringify(r.data)}`);
    await admin(`/api/modules/facility/records/${encodeURIComponent(r.data.record._id)}`, { method: 'DELETE' });
    const on = await admin('/api/master/strict', { method: 'POST', body: { strict: true } });
    assert(on.data.strict === true, '未能恢复强制开关');
  });
  await check('从既有台账归集清单，并报出写法漂移', async () => {
    // 先在关闭强制的状态下造两条写法不一致的历史数据：
    // 「三分公司」与「三分公司（东区）」中的全角括号，正是现实中最常见的漂移来源
    await admin('/api/master/strict', { method: 'POST', body: { strict: false } });
    const ids = [];
    for (const raw of ['三分公司', '三分公司 ', '四分公司（东区）']) {
      const r = await admin('/api/modules/facility/records', {
        method: 'POST',
        body: { properties: { 设施名称: { text: '归集样本' }, 单位: { text: raw } } },
      });
      assert(r.status === 201, JSON.stringify(r.data));
      ids.push(r.data.record._id);
    }
    await admin('/api/master/strict', { method: 'POST', body: { strict: true } });

    const r = await admin('/api/master/seed', { method: 'POST', body: {} });
    assert(r.status === 200, JSON.stringify(r.data));
    const units = r.data.units.map((u) => u.name);
    assert(units.includes('三分公司'), `应归集出「三分公司」：${units.join(',')}`);
    // 全角括号被规范成半角，两种写法归并为同一个单位
    assert(units.includes('四分公司(东区)'), `全角括号应归一：${units.join(',')}`);
    assert(!units.includes('四分公司（东区）'), '全角写法不应单独入清单');
    assert(r.data.addedUnits >= 2, `应至少新增 2 个单位，实际 ${r.data.addedUnits}`);
    /*
     * 写法漂移现在不会再由新数据产生：normalizeProperties 落库前就把「单位/项目名称」
     * 规范化了，「三分公司 」和「三分公司」进库就是同一个值。
     * 这是本次修复的核心——以前校验用规范名、存储用原始名，
     * 于是 carry.js 按「单位|项目名称」匹配计提链条时会认成两个项目，
     * 上期基数丢成 0，本期计提额静默翻倍。
     * seedFromRecords 的 drift 字段因此退化为「历史数据体检工具」：
     * 只对本次修复之前写入的记录报告漂移。这里断言新数据不再漂移。
     */
    assert(
      Array.isArray(r.data.drift) && !r.data.drift.some((d) => d.name === '三分公司'),
      `新写入的数据不应再产生写法漂移（落库前已规范化）：${JSON.stringify(r.data.drift)}`,
    );
    for (const id of ids) await admin(`/api/modules/facility/records/${encodeURIComponent(id)}`, { method: 'DELETE' });
  });

  console.log('\n本月结转：');
  await check('准备上期数据（4 月）', async () => {
    const proj = await admin('/api/master/projects', {
      method: 'POST',
      body: { unit: '第一公司', name: '结转测试项目', rate: 3 },
    });
    assert(proj.status === 201, JSON.stringify(proj.data));
    const r = await admin('/api/modules/levy/records', {
      method: 'POST',
      body: {
        properties: {
          单位: { text: '第一公司' },
          项目名称: { text: '结转测试项目' },
          会计期间: { date: '2026-04-01' },
          '累计产值(元)': { number: 8000000 },
          '计提比例(%)': { number: 3 },
        },
      },
    });
    assert(r.status === 201, JSON.stringify(r.data));
  });
  await check('结转预览列出上期名册并带上期数值', async () => {
    const r = await admin('/api/carry/levy?from=2026-04&to=2026-05');
    assert(r.status === 200, JSON.stringify(r.data));
    const it = r.data.items.find((x) => x.project === '结转测试项目');
    assert(it, `预览里应有「结转测试项目」：${JSON.stringify(r.data.items)}`);
    assert(it.carried['计提比例(%)'] === 3, `比例应沿用：${JSON.stringify(it.carried)}`);
    assert(it.reference === 8000000, `上期数值应为 8000000，实际 ${it.reference}`);
  });
  await check('不可结转的模块被拒绝（400）', async () => {
    const r = await admin('/api/carry/facility?from=2026-04&to=2026-05');
    assert(r.status === 400, `期望 400，实际 ${r.status}`);
  });
  await check('来源期间不早于目标期间时被拒绝（400）', async () => {
    const r = await admin('/api/carry/levy?from=2026-05&to=2026-05');
    assert(r.status === 400, `期望 400，实际 ${r.status}`);
  });
  await check('结转时本期开累小于上期被拒绝（400）', async () => {
    const preview = await admin('/api/carry/levy?from=2026-04&to=2026-05');
    const it = preview.data.items.find((x) => x.project === '结转测试项目');
    const r = await admin('/api/carry/levy', {
      method: 'POST',
      body: { from: '2026-04', to: '2026-05', values: { [it.identity]: 7000000 } },
    });
    assert(r.status === 400, `期望 400，实际 ${r.status}: ${JSON.stringify(r.data)}`);
    assert(String(r.data.error).includes('小于上期'), r.data.error);
  });
  await check('结转生成本期记录，名称与比例照抄、数字用填的新值', async () => {
    const preview = await admin('/api/carry/levy?from=2026-04&to=2026-05');
    const it = preview.data.items.find((x) => x.project === '结转测试项目');
    const r = await admin('/api/carry/levy', {
      method: 'POST',
      body: { from: '2026-04', to: '2026-05', values: { [it.identity]: 9500000 } },
    });
    assert(r.status === 200 && r.data.inserted >= 1, JSON.stringify(r.data));
    const recs = await admin('/api/modules/levy/records');
    const may = recs.data.results.find(
      (x) => x['项目名称'] === '结转测试项目' && String(x['会计期间']).startsWith('2026-05'),
    );
    assert(may, '未找到结转生成的 5 月记录');
    assert(may['计提比例(%)'] === 3, `比例应沿用 3，实际 ${may['计提比例(%)']}`);
    assert(may['累计产值(元)'] === 9500000, `开累应为 9500000，实际 ${may['累计产值(元)']}`);
  });
  await check('重复结转不会生成重复记录', async () => {
    const r = await admin('/api/carry/levy?from=2026-04&to=2026-05');
    assert(
      !r.data.items.some((x) => x.project === '结转测试项目'),
      '已存在的记录不应再出现在待结转名册里',
    );
    assert(
      r.data.skipped.some((s) => s.reason.includes('已有这条记录')),
      JSON.stringify(r.data.skipped),
    );
  });
  await check('目标期间已结账时禁止结转（409）', async () => {
    await admin('/api/closures', { method: 'POST', body: { module: 'levy', period: '2026-06', closed: true } });
    const r = await admin('/api/carry/levy', { method: 'POST', body: { from: '2026-05', to: '2026-06', values: {} } });
    assert(r.status === 409, `期望 409，实际 ${r.status}`);
    await admin('/api/closures', { method: 'POST', body: { module: 'levy', period: '2026-06', closed: false } });
  });
  await check('只读账号不能结转（403）', async () => {
    const r = await viewer('/api/carry/levy', { method: 'POST', body: { from: '2026-04', to: '2026-07', values: {} } });
    assert(r.status === 403, `期望 403，实际 ${r.status}`);
  });
  await check('低值易耗品也能结转（名册照抄、数量待填）', async () => {
    const seed = await admin('/api/modules/lvc/records', {
      method: 'POST',
      body: {
        properties: {
          单位: { text: '第一公司' },
          资产名称: { text: '安全帽' },
          规格型号: { text: 'ABS-01' },
          入账月份: { date: '2026-04-01' },
          计量单位: { text: '顶' },
          数量: { number: 10 },
          '单价(元)': { number: 25 },
          成本对象: { text: '结转测试项目' },
        },
      },
    });
    assert(seed.status === 201, JSON.stringify(seed.data));
    const p = await admin('/api/carry/lvc?from=2026-04&to=2026-05');
    assert(p.status === 200, JSON.stringify(p.data));
    const it = p.data.items.find((x) => x.project === '安全帽 · ABS-01');
    assert(it, `预览里应有「安全帽 · ABS-01」：${JSON.stringify(p.data.items)}`);
    assert(it.carried['单价(元)'] === 25, `单价应沿用：${JSON.stringify(it.carried)}`);
    assert(it.inputField === '数量', `待填字段应是数量，实际 ${it.inputField}`);
  });
  await check('结转的当期发生数不受「不能小于上期」限制', async () => {
    /*
     * lvc 的「本期领用数量」是当期发生数：上月领 10 顶、这月领 2 顶完全正常。
     * 拿它去比上期会把正常录入拦下来，所以 cumulative:false 的模块必须放行。
     * levy/union 的开累字段仍然要拦（上一条用例已覆盖）。
     */
    const p = await admin('/api/carry/lvc?from=2026-04&to=2026-05');
    assert(p.data.cumulative === false, `lvc 应声明为非累计口径，实际 ${p.data.cumulative}`);
    const it = p.data.items.find((x) => x.project === '安全帽 · ABS-01');
    const r = await admin('/api/carry/lvc', {
      method: 'POST',
      body: { from: '2026-04', to: '2026-05', values: { [it.identity]: 2 } },
    });
    assert(r.status === 200 && r.data.inserted >= 1, `本期领用数少于上期应被接受：${JSON.stringify(r.data)}`);
    const recs = await admin('/api/modules/lvc/records');
    const may = recs.data.results.find(
      (x) => x['资产名称'] === '安全帽' && String(x['入账月份']).startsWith('2026-05'),
    );
    assert(may, '未找到结转生成的 5 月低值易耗品记录');
    assert(may['数量'] === 2, `数量应为 2，实际 ${may['数量']}`);
    assert(may['单价(元)'] === 25, `单价应沿用 25，实际 ${may['单价(元)']}`);
  });
  await check('「未完工」不再被结转误判为已完工', async () => {
    /*
     * 回归：旧口径用 /完工|已结束|已关闭|停工/ 做子串匹配，
     * 「未完工」「尚未完工」都会被当成完成标记——结转名册少一条、
     * 漏录提醒也不报（两者共用这里的口径），该项目当月计提静默缺失。
     * 现在只认显式的「已」字头标记，否定写法必须照常结转。
     */
    const proj = await admin('/api/master/projects', {
      method: 'POST',
      body: { unit: '第一公司', name: '未完工测试项目', rate: 2 },
    });
    assert(proj.status === 201, JSON.stringify(proj.data));
    const seed = await admin('/api/modules/levy/records', {
      method: 'POST',
      body: {
        properties: {
          单位: { text: '第一公司' },
          项目名称: { text: '未完工测试项目' },
          会计期间: { date: '2026-07-01' },
          '累计产值(元)': { number: 13000000 },
          '计提比例(%)': { number: 2 },
          备注: { text: '本项目尚未完工，继续计提' },
        },
      },
    });
    assert(seed.status === 201, JSON.stringify(seed.data));
    const p = await admin('/api/carry/levy?from=2026-07&to=2026-08');
    assert(p.status === 200, JSON.stringify(p.data));
    assert(
      p.data.items.some((x) => x.project === '未完工测试项目'),
      `「尚未完工」应照常进入待结转名册：${JSON.stringify({ items: p.data.items, skipped: p.data.skipped })}`,
    );
    assert(
      !p.data.skipped.some((s) => s.identity.includes('未完工测试项目')),
      `否定写法不应出现在跳过名单：${JSON.stringify(p.data.skipped)}`,
    );
  });

  console.log('\n粘贴导入预检：');
  await check('预检逐行返回校验结果，不写库', async () => {
    const before = await admin('/api/modules/levy/records');
    const r = await admin('/api/modules/levy/import/check', {
      method: 'POST',
      body: {
        rows: [
          {
            单位: { text: '第一公司' },
            项目名称: { text: '结转测试项目' },
            会计期间: { date: '2026-07-01' },
            '累计产值(元)': { number: 10000000 },
            '计提比例(%)': { number: 3 },
          },
          { 单位: { text: '不存在的公司' }, 项目名称: { text: '某项目' }, 会计期间: { date: '2026-07-01' } },
          { 单位: { text: '第一公司' }, '累计产值(元)': { number: '不是数字' } },
        ],
      },
    });
    assert(r.status === 200, JSON.stringify(r.data));
    assert(r.data.total === 3 && r.data.valid === 1, `应 3 行 1 有效，实际 ${r.data.total}/${r.data.valid}`);
    assert(r.data.rows[0].ok === true, JSON.stringify(r.data.rows[0]));
    assert(!r.data.rows[1].ok && String(r.data.rows[1].errors.join()).includes('受控清单'), JSON.stringify(r.data.rows[1]));
    assert(!r.data.rows[2].ok, JSON.stringify(r.data.rows[2]));
    const after = await admin('/api/modules/levy/records');
    assert(after.data.total === before.data.total, '预检不应写库');
  });
  await check('预检能识别已结账期间', async () => {
    await admin('/api/closures', { method: 'POST', body: { module: 'levy', period: '2026-07', closed: true } });
    const r = await admin('/api/modules/levy/import/check', {
      method: 'POST',
      body: { rows: [{ 单位: { text: '第一公司' }, 项目名称: { text: '结转测试项目' }, 会计期间: { date: '2026-07-01' } }] },
    });
    assert(r.data.rows[0].ok === false && String(r.data.rows[0].errors.join()).includes('已结账'), JSON.stringify(r.data.rows[0]));
    await admin('/api/closures', { method: 'POST', body: { module: 'levy', period: '2026-07', closed: false } });
  });
  await check('导入时清单外名称被逐行拦截', async () => {
    const r = await admin('/api/modules/levy/import', {
      method: 'POST',
      body: {
        rows: [
          {
            单位: { text: '第一公司' },
            项目名称: { text: '结转测试项目' },
            会计期间: { date: '2026-08-01' },
            '累计产值(元)': { number: 11000000 },
          },
          { 单位: { text: '野单位' }, 项目名称: { text: '野项目' }, 会计期间: { date: '2026-08-01' } },
        ],
      },
    });
    assert(r.status === 200, JSON.stringify(r.data));
    assert(r.data.inserted === 1 && r.data.skipped === 1, `应导 1 跳 1，实际 ${r.data.inserted}/${r.data.skipped}`);
  });
  await check('管理员迁移可显式跳过清单校验', async () => {
    const r = await admin('/api/modules/levy/import', {
      method: 'POST',
      body: {
        allowNewNames: true,
        rows: [
          {
            单位: { text: '历史遗留公司' },
            项目名称: { text: '历史项目' },
            会计期间: { date: '2026-09-01' },
            '累计产值(元)': { number: 500000 },
          },
        ],
      },
    });
    assert(r.status === 200 && r.data.inserted === 1, JSON.stringify(r.data));
    assert(r.data.bypassedMasterData === true, '应标记已跳过清单校验');
  });

  console.log('\n期初接续（设施 / 固定资产）：');
  await check('期初已摊销与期初截止期间可成对写入', async () => {
    const r = await admin('/api/modules/facility/records', {
      method: 'POST',
      body: {
        properties: {
          设施名称: { text: '旧账接续板房' },
          单位: { text: '第一公司' },
          '原值(元)': { number: 120000 },
          '残值率(%)': { number: 5 },
          '摊销期限(月)': { number: 24 },
          启用日期: { date: '2025-01-01' },
          '期初已摊销(元)': { number: 47500 },
          期初截止期间: { date: '2025-12-01' },
        },
      },
    });
    assert(r.status === 201, JSON.stringify(r.data));
    assert(r.data.record['期初已摊销(元)'] === 47500, JSON.stringify(r.data.record));
    assert(String(r.data.record['期初截止期间']).startsWith('2025-12'), r.data.record['期初截止期间']);
  });
  await check('期初已折旧字段在固定资产模块可用', async () => {
    const r = await admin('/api/modules/asset/records', {
      method: 'POST',
      body: {
        properties: {
          资产名称: { text: '旧账接续装载机' },
          单位: { text: '第一公司' },
          '原值(元)': { number: 600000 },
          '残值率(%)': { number: 5 },
          '预计使用年限(年)': { number: 10 },
          启用日期: { date: '2022-06-01' },
          '期初已折旧(元)': { number: 199500 },
          期初截止期间: { date: '2025-12-01' },
        },
      },
    });
    assert(r.status === 201, JSON.stringify(r.data));
    assert(r.data.record['期初已折旧(元)'] === 199500, JSON.stringify(r.data.record));
  });
  await check('两个模块的 schema 都声明了期初字段', async () => {
    const t = await admin('/api/modules/facility/schema');
    const a = await admin('/api/modules/asset/schema');
    assert(t.data.properties.some((p) => p.name === '期初已摊销(元)'), 'facility 缺少期初已摊销');
    assert(t.data.properties.some((p) => p.name === '期初截止期间'), 'facility 缺少期初截止期间');
    assert(a.data.properties.some((p) => p.name === '期初已折旧(元)'), 'asset 缺少期初已折旧');
    assert(a.data.properties.some((p) => p.name === '期初截止期间'), 'asset 缺少期初截止期间');
  });

  console.log('\n业务校验（服务端兜底：API / 导入与录入表单同一套规则）：');
  /*
   * 录入表单拦得住的规则，曾经只在浏览器里存在：REST API、粘贴导入、脚本迁移
   * 全部绕过，负数原值、不成对的期初接续、比上期还小的开累都能落库，
   * 然后被摊销/计提算法算出看似自洽的错误金额。这一节钉住服务端兜底。
   */
  await check('负数原值被拒绝（400）', async () => {
    const r = await admin('/api/modules/facility/records', {
      method: 'POST',
      body: { properties: { 单位: { text: '第一公司' }, 设施名称: { text: '负数测试' }, '原值(元)': { number: -1000 } } },
    });
    assert(r.status === 400, `期望 400，实际 ${r.status}: ${JSON.stringify(r.data)}`);
    assert(String(r.data.error).includes('负数'), r.data.error);
  });
  await check('负数数量经批量导入也被逐行拒绝', async () => {
    const r = await admin('/api/modules/lvc/import', {
      method: 'POST',
      body: { rows: [{ 单位: '第一公司', 资产名称: '负数量', 入账月份: '2026-03-01', 数量: -5, '单价(元)': 10 }] },
    });
    assert(r.status === 200, JSON.stringify(r.data));
    assert(r.data.inserted === 0 && r.data.skipped === 1, `应 0 进 1 跳，实际 ${JSON.stringify(r.data)}`);
    assert(String(r.data.errors[0]).includes('负数'), r.data.errors[0]);
  });
  await check('计提比例超出 100 被拒绝（400）', async () => {
    const r = await admin('/api/modules/levy/records', {
      method: 'POST',
      body: {
        properties: {
          单位: { text: '第一公司' },
          项目名称: { text: '未完工测试项目' },
          会计期间: { date: '2026-10-01' },
          '累计产值(元)': { number: 14000000 },
          '计提比例(%)': { number: 150 },
        },
      },
    });
    assert(r.status === 400, `期望 400，实际 ${r.status}: ${JSON.stringify(r.data)}`);
  });
  await check('期初接续不成对被拒绝（400）', async () => {
    const onlyAmt = await admin('/api/modules/facility/records', {
      method: 'POST',
      body: {
        properties: {
          单位: { text: '第一公司' },
          设施名称: { text: '不成对测试' },
          '原值(元)': { number: 100000 },
          '期初已摊销(元)': { number: 50000 },
        },
      },
    });
    assert(onlyAmt.status === 400, `只填金额期望 400，实际 ${onlyAmt.status}`);
    assert(String(onlyAmt.data.error).includes('成对'), onlyAmt.data.error);
    const onlyYm = await admin('/api/modules/facility/records', {
      method: 'POST',
      body: {
        properties: {
          单位: { text: '第一公司' },
          设施名称: { text: '不成对测试' },
          期初截止期间: { date: '2025-12-01' },
        },
      },
    });
    assert(onlyYm.status === 400, `只填期间期望 400，实际 ${onlyYm.status}`);
  });
  await check('期初已摊销超过应摊总额被拒绝（400）', async () => {
    const r = await admin('/api/modules/facility/records', {
      method: 'POST',
      body: {
        properties: {
          单位: { text: '第一公司' },
          设施名称: { text: '期初超额测试' },
          '原值(元)': { number: 10000 },
          '残值率(%)': { number: 0 },
          '摊销期限(月)': { number: 10 },
          启用日期: { date: '2025-06-01' },
          '期初已摊销(元)': { number: 999999 },
          期初截止期间: { date: '2026-01-01' },
        },
      },
    });
    assert(r.status === 400, `期望 400，实际 ${r.status}: ${JSON.stringify(r.data)}`);
    assert(String(r.data.error).includes('不能大于应摊总额'), r.data.error);
  });
  await check('开累回退经 API 直写被拒绝（400）', async () => {
    const prev = await admin('/api/modules/levy/records?period=2026-08');
    const rec = prev.data.results.find((x) => x['项目名称'] === '结转测试项目');
    assert(rec, '需要 8 月的结转测试项目记录做基数');
    const r = await admin('/api/modules/levy/records', {
      method: 'POST',
      body: {
        properties: {
          单位: { text: '第一公司' },
          项目名称: { text: '结转测试项目' },
          会计期间: { date: '2026-11-01' },
          '累计产值(元)': { number: 5000000 },
        },
      },
    });
    assert(r.status === 400, `期望 400，实际 ${r.status}: ${JSON.stringify(r.data)}`);
    assert(String(r.data.error).includes('不能小于上期'), r.data.error);
  });
  await check('回填历史期间不能超过后期已录的开累（400）', async () => {
    const r = await admin('/api/modules/levy/records', {
      method: 'POST',
      body: {
        properties: {
          单位: { text: '第一公司' },
          项目名称: { text: '结转测试项目' },
          会计期间: { date: '2026-03-01' },
          '累计产值(元)': { number: 20000000 },
        },
      },
    });
    assert(r.status === 400, `期望 400，实际 ${r.status}: ${JSON.stringify(r.data)}`);
    assert(String(r.data.error).includes('不能大于下期'), r.data.error);
  });
  await check('同一单位、项目、期间重复新增被拒绝（400）', async () => {
    const r = await admin('/api/modules/levy/records', {
      method: 'POST',
      body: {
        properties: {
          单位: { text: '第一公司' },
          项目名称: { text: '结转测试项目' },
          会计期间: { date: '2026-05-01' },
          '累计产值(元)': { number: 9500000 },
        },
      },
    });
    assert(r.status === 400, `期望 400，实际 ${r.status}: ${JSON.stringify(r.data)}`);
    assert(String(r.data.error).includes('已有记录'), r.data.error);
  });
  await check('批量导入批内重复被逐行跳过', async () => {
    const r = await admin('/api/modules/levy/import', {
      method: 'POST',
      body: {
        rows: [
          { 单位: '第一公司', 项目名称: '未完工测试项目', 会计期间: '2026-08-01', '累计产值(元)': 13500000 },
          { 单位: '第一公司', 项目名称: '未完工测试项目', 会计期间: '2026-08-01', '累计产值(元)': 13500000 },
        ],
      },
    });
    assert(r.status === 200, JSON.stringify(r.data));
    assert(r.data.inserted === 1 && r.data.skipped === 1, `应导 1 跳 1，实际 ${r.data.inserted}/${r.data.skipped}`);
    assert(String(r.data.errors[0]).includes('已有记录'), r.data.errors[0]);
  });
  await check('修改无关字段不被存量数据与业务校验拦住', async () => {
    // 校验只针对本次提交的字段：存量数据即使有历史问题，改备注也应该正常
    const recs = await admin('/api/modules/levy/records?period=2026-08');
    const rec = recs.data.results.find((x) => x['项目名称'] === '结转测试项目');
    assert(rec, '需要 8 月记录做样本');
    const r = await admin(`/api/modules/levy/records/${encodeURIComponent(rec._id)}`, {
      method: 'PATCH',
      body: { properties: { 备注: { text: '改备注不应被业务校验拦住' } } },
    });
    assert(r.status === 200, `HTTP ${r.status}: ${JSON.stringify(r.data)}`);
  });
  await check('管理员迁移 allowNewNames 同时跳过业务校验', async () => {
    // 历史脏数据里可能本就有负数/不成对——迁移不该被拦死，进账后走人工核对
    const r = await admin('/api/modules/facility/import', {
      method: 'POST',
      body: {
        allowNewNames: true,
        rows: [
          {
            单位: '历史遗留公司',
            设施名称: '负数原值的历史设施',
            '原值(元)': { number: -100 },
            '残值率(%)': { number: 5 },
            '摊销期限(月)': { number: 12 },
            启用日期: { date: '2024-01-01' },
            '期初已摊销(元)': { number: 10 },
          },
        ],
      },
    });
    assert(r.status === 200 && r.data.inserted === 1, JSON.stringify(r.data));
    assert(r.data.bypassedBusiness === true, '应标记已跳过业务校验');
    assert(r.data.bypassedMasterData === true, '应标记已跳过清单校验');
    const after = await admin('/api/modules/facility/records');
    const junk = after.data.results.find((x) => x['设施名称'] === '负数原值的历史设施');
    assert(junk, '绕过校验的记录应已入库');
    const del = await admin(`/api/modules/facility/records/${encodeURIComponent(junk._id)}`, { method: 'DELETE' });
    assert(del.status === 200, JSON.stringify(del.data));
  });
  await check('预检同样报出业务错误（预检与导入同一套规则）', async () => {
    const r = await admin('/api/modules/levy/import/check', {
      method: 'POST',
      body: {
        rows: [
          { 单位: { text: '第一公司' }, 项目名称: { text: '未完工测试项目' }, 会计期间: { date: '2026-10-01' }, '累计产值(元)': { number: 100 }, '计提比例(%)': { number: 2 } },
        ],
      },
    });
    assert(r.status === 200, JSON.stringify(r.data));
    assert(r.data.rows[0].ok === false, `回退行预检必须不通过：${JSON.stringify(r.data.rows[0])}`);
    assert(
      r.data.rows[0].errors.some((e) => e.includes('不能小于上期')),
      `应报出开累回退：${JSON.stringify(r.data.rows[0].errors)}`,
    );
  });

  console.log('\n静态资源与退出：');
  await check('首页可访问且带安全响应头', async () => {
    const resp = await fetch(`${BASE}/`);
    assert(resp.status === 200, `HTTP ${resp.status}`);
    const html = await resp.text();
    assert(html.includes('财务管理台'), '首页内容异常');
    assert(html.includes('bridge.js'), '首页应引用 bridge.js');
    assert(resp.headers.get('content-security-policy'), '缺少 CSP 头');
    assert(resp.headers.get('x-content-type-options') === 'nosniff', '缺少 nosniff');
  });
  await check('台账以 ES 模块方式提供，入口与关键模块可访问', async () => {
    const main = await fetch(`${BASE}/app/main.js`);
    assert(main.status === 200, `app/main.js HTTP ${main.status}`);
    const mainJs = await main.text();
    assert(mainJs.includes('__FIN_APP__'), '入口未暴露重绘接口');
    assert(mainJs.includes("from './modules/registry.js'"), '入口未从模块注册表导入');

    const env = await (await fetch(`${BASE}/app/core/env.js`)).text();
    assert(env.includes('FIN_STORE'), '未提供共享存储');

    const registry = await (await fetch(`${BASE}/app/modules/registry.js`)).text();
    assert(registry.includes('facility') && registry.includes('levy'), '模块注册表内容异常');

    const facility = await (await fetch(`${BASE}/app/modules/facility.js`)).text();
    assert(facility.includes("dbId: 'facility'"), 'dbId 未使用模块 key');
    assert(!/[^.a-zA-Z]localStorage\./.test(facility), '业务模块不应直接使用 localStorage');
  });
  await check('缺失的脚本返回 404 而不是回落到首页', async () => {
    const resp = await fetch(`${BASE}/app/does-not-exist.js`);
    assert(resp.status === 404, `期望 404，实际 ${resp.status}`);
  });
  await check('三个新面板模块已随构建产出', async () => {
    for (const p of ['app/features/carry.js', 'app/features/paste.js', 'app/features/masterdata.js']) {
      const resp = await fetch(`${BASE}/${p}`);
      assert(resp.status === 200, `${p} HTTP ${resp.status}`);
    }
  });
  await check('路径穿越攻击被拦截', async () => {
    const resp = await fetch(`${BASE}/../server.js`);
    assert(resp.status === 200 || resp.status === 403 || resp.status === 404, `HTTP ${resp.status}`);
    const text = await resp.text();
    assert(!text.includes('bootstrapAdmin'), '服务端源码被泄露！');
  });
  console.log('\n备份与恢复：');
  await check('恢复接口默认只预演，不写入数据', async () => {
    // 原来只有导出没有导入，那份备份只能看不能用；备份的价值等于恢复能力
    const dump = await admin('/api/export');
    const payload = typeof dump.data === 'string' ? JSON.parse(dump.data) : dump.data;
    const before = await admin('/api/modules/facility/records');
    const r = await admin('/api/import', { method: 'POST', body: { payload, dryRun: true } });
    assert(r.status === 200 && r.data.dryRun === true, JSON.stringify(r.data).slice(0, 160));
    assert(typeof r.data.willReplace.facility === 'number', '应报出将被覆盖的条数');
    assert(typeof r.data.incoming.facility === 'number', '应报出待恢复的条数');
    const after = await admin('/api/modules/facility/records');
    assert(after.data.results.length === before.data.results.length, '预演不该改动任何数据');
  });
  await check('恢复整套账（含受控清单与结账锁）', async () => {
    const dump = await admin('/api/export');
    const payload = typeof dump.data === 'string' ? JSON.parse(dump.data) : dump.data;
    const unitsBefore = (await admin('/api/master/units')).data.units.length;
    // 先破坏现状：删掉一条记录、加一个清单外的单位
    const recs = await admin('/api/modules/facility/records');
    const victim = recs.data.results[0];
    assert(victim, '需要至少一条 facility 记录');
    await admin(`/api/modules/facility/records/${encodeURIComponent(victim._id)}`, { method: 'DELETE' });
    await admin('/api/master/units', { method: 'POST', body: { name: '恢复前多出来的单位' } });

    const r = await admin('/api/import', { method: 'POST', body: { payload, confirm: '替换全部数据' } });
    assert(r.status === 200 && r.data.dryRun === false, JSON.stringify(r.data).slice(0, 200));
    assert(r.data.backupBefore, '恢复前应自动留一份备份');

    const back = await admin('/api/modules/facility/records');
    assert(back.data.results.some((x) => x._id === victim._id), '被删掉的记录应当恢复回来');
    const restored = back.data.results.find((x) => x._id === victim._id);
    assert(restored._createdBy === victim._createdBy, `创建人痕迹应保留：${restored._createdBy}`);
    const unitsAfter = (await admin('/api/master/units')).data.units;
    assert(unitsAfter.length === unitsBefore, `清单应回到备份时的状态，实际 ${unitsAfter.length} vs ${unitsBefore}`);
    assert(!unitsAfter.some((u) => u.name === '恢复前多出来的单位'), '备份里没有的单位不该留下');
  });
  await check('只读账号不能恢复备份（403）', async () => {
    const r = await viewer('/api/import', { method: 'POST', body: { payload: { modules: {} }, dryRun: true } });
    assert(r.status === 403, `期望 403，实际 ${r.status}`);
  });
  await check('非本系统导出的文件被拒绝（400）', async () => {
    const r = await admin('/api/import', { method: 'POST', body: { payload: { hello: 'world' }, dryRun: true } });
    assert(r.status === 400, `期望 400，实际 ${r.status}：${JSON.stringify(r.data)}`);
  });

  console.log('\n数据完整性（截断防护）：');
  await check('超过单次上限时 total 报真实总数并标记 truncated', async () => {
    /*
     * 这是本系统最危险的一类故障：服务端按 (期间, 创建时间) 升序返回，
     * limit 砍掉的是**最新**的记录。而 levy 的计提是链式的
     * （本期 = 本期累计 − 上期累计），链条尾部被截掉后仍然算得出
     * 一个自洽但错误的金额，界面上没有任何迹象表明它是错的。
     *
     * 原来 total 返回的是截断后的 rows.length，前端永远看到
     * total === results.length，根本无从判断数据不全。
     */
    const before = await admin('/api/modules/lvc/records');
    const baseline = before.data.total;
    assert(baseline >= 2, `需要至少 2 条 lvc 记录做样本，实际 ${baseline}`);
    const r = await admin('/api/modules/lvc/records?limit=1');
    assert(r.status === 200, JSON.stringify(r.data));
    assert(r.data.results.length === 1, `应只返回 1 条，实际 ${r.data.results.length}`);
    assert(r.data.total === baseline, `total 必须是真实总数 ${baseline}，实际 ${r.data.total}`);
    assert(r.data.returned === 1, `returned 应为 1，实际 ${r.data.returned}`);
    assert(r.data.truncated === true, 'truncated 必须为 true，否则前端无法察觉数据不全');
  });
  await check('未截断时 truncated 为 false', async () => {
    const r = await admin('/api/modules/lvc/records');
    assert(r.data.truncated === false, `未截断应为 false，实际 ${r.data.truncated}`);
    assert(r.data.returned === r.data.total, `returned(${r.data.returned}) 应等于 total(${r.data.total})`);
  });
  await check('截断砍掉的是最新期间（这正是链式计提出错的原因）', async () => {
    const all = await admin('/api/modules/levy/records');
    const periods = [...new Set(all.data.results.map((x) => String(x['会计期间']).slice(0, 7)))].sort();
    assert(periods.length >= 2, `需要至少 2 个期间做样本，实际 ${JSON.stringify(periods)}`);
    const cut = await admin('/api/modules/levy/records?limit=1');
    const got = String(cut.data.results[0]['会计期间']).slice(0, 7);
    assert(got === periods[0], `截断后留下的应是最早期间 ${periods[0]}，实际 ${got}`);
    assert(cut.data.truncated === true, '必须标记 truncated');
  });
  await check('前端请求的上限与服务端一致（不能再写死 200）', async () => {
    /*
     * 回归防线：engine.js 曾经写死 pageSize: 200，而服务端上限是 20000。
     * 一个模块装 20 个项目时，200 条只够 10 个月，第一年就会撞上。
     */
    const src = await readFile(new URL('../frontend/app/engine.js', import.meta.url), 'utf8');
    assert(!/pageSize:\s*200\b/.test(src), 'engine.js 不能把 pageSize 写死成 200');
    const m = src.match(/var\s+MAX_ROWS\s*=\s*(\d+)/);
    assert(m, 'engine.js 应定义 MAX_ROWS');
    assert(Number(m[1]) >= 20000, `MAX_ROWS 应不小于服务端默认上限 20000，实际 ${m[1]}`);
    assert(/pageSize:\s*MAX_ROWS/.test(src), 'loadData 应使用 MAX_ROWS 作为 pageSize');
  });
  await check('数据不全时前端拒绝计算与导出（源码防线）', async () => {
    const engine = await readFile(new URL('../frontend/app/engine.js', import.meta.url), 'utf8');
    assert(/cur\.truncated/.test(engine), 'engine.js 应记录 truncated 状态');
    assert(/renderTruncated/.test(engine), 'engine.js 应有拒绝计算的渲染分支');
    const menu = await readFile(new URL('../frontend/app/menu.js', import.meta.url), 'utf8');
    assert(/truncated/.test(menu), 'menu.js 必须在数据不全时挡住打印与导出');
    for (const act of ['printMonth', 'printAll', 'xlsMonth', 'xlsAll', 'json']) {
      assert(menu.includes(`'${act}'`), `menu.js 的输出动作应包含 ${act}`);
    }
  });

  console.log('\n漏录提醒与审计追溯：');
  await check('总览返回上期有、本期缺的名册（漏录）', async () => {
    /*
     * 少计提在账面上每一条都是对的，只有拿总数跟上期比才能发现，
     * 而月结时没人会去比。所以必须由服务端主动算出来推到总览页。
     */
    await admin('/api/period', { method: 'POST', body: { period: '2026-06' } });
    /* 受控清单是强制的：项目必须先进清单才能录记录（这一层正是防计提链条断裂的） */
    const proj = await admin('/api/master/projects', {
      method: 'POST',
      body: { unit: '第一公司', name: '漏录测试项目', rate: 2 },
    });
    assert(proj.status === 201, JSON.stringify(proj.data));
    const seed = await admin('/api/modules/levy/records', {
      method: 'POST',
      body: {
        properties: {
          单位: { text: '第一公司' },
          项目名称: { text: '漏录测试项目' },
          会计期间: { date: '2026-05-01' },
          '累计产值(元)': { number: 1000000 },
          '计提比例(%)': { number: 2 },
        },
      },
    });
    assert(seed.status === 201, JSON.stringify(seed.data));
    const ov = await admin('/api/overview');
    assert(ov.status === 200, JSON.stringify(ov.data));
    assert(ov.data.missing, '总览应返回 missing 字段');
    const s = ov.data.missing.levy;
    assert(s, `levy 应有漏录提醒：${JSON.stringify(ov.data.missing)}`);
    assert(s.to === '2026-06', `目标期间应是账套期间 2026-06，实际 ${s.to}`);
    assert(
      s.missing.some((x) => x.project === '漏录测试项目'),
      `漏录名单应含「漏录测试项目」：${JSON.stringify(s.missing)}`,
    );
  });
  await check('补录后漏录提醒消失', async () => {
    const p = await admin('/api/carry/levy?from=2026-05&to=2026-06');
    const it = p.data.items.find((x) => x.project === '漏录测试项目');
    assert(it, '待结转名册里应有漏录的项目');
    const r = await admin('/api/carry/levy', {
      method: 'POST',
      body: { from: '2026-05', to: '2026-06', values: { [it.identity]: 1200000 } },
    });
    assert(r.status === 200, JSON.stringify(r.data));
    const ov = await admin('/api/overview');
    const s = ov.data.missing.levy;
    assert(
      !s || !s.missing.some((x) => x.project === '漏录测试项目'),
      `补录后不该再提醒：${JSON.stringify(s)}`,
    );
  });
  await check('漏录提醒与结转口径一致（提醒的都能结转出来）', async () => {
    const ov = await admin('/api/overview');
    for (const [key, m] of Object.entries(ov.data.missing || {})) {
      const p = await admin(`/api/carry/${key}?from=${m.from}&to=${m.to}`);
      assert(p.status === 200, `${key} 结转预览失败：${JSON.stringify(p.data)}`);
      assert(
        p.data.items.length === m.count,
        `${key}：提醒 ${m.count} 项但结转只能补 ${p.data.items.length} 项——两处口径必须一致`,
      );
    }
  });
  await check('按 recId 查得到单条记录的完整修改历史', async () => {
    const created = await admin('/api/modules/facility/records', {
      method: 'POST',
      body: { properties: { 单位: { text: '第一公司' }, 设施名称: { text: '追溯样本' }, '原值(元)': { number: 1000 } } },
    });
    assert(created.status === 201, JSON.stringify(created.data));
    const id = created.data.record._id;
    let rev = created.data.record._rev;
    for (const v of [2000, 3000]) {
      const up = await admin(`/api/modules/facility/records/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: { rev, properties: { '原值(元)': { number: v } } },
      });
      assert(up.status === 200, JSON.stringify(up.data));
      rev = up.data.record._rev;
    }
    const a = await admin(`/api/audit?recId=${encodeURIComponent(id)}`);
    assert(a.status === 200, JSON.stringify(a.data));
    const rows = a.data.rows;
    assert(rows.length >= 3, `应至少有 1 次创建 + 2 次修改，实际 ${rows.length}`);
    assert(rows.every((x) => x.rec_id === id), '不应混入其他记录的日志');
    // 单条记录的历史按时间正序，读起来是「从建立到最近一次修改」
    assert(rows[0].action === 'record.create', `第一条应是创建，实际 ${rows[0].action}`);
    const last = rows[rows.length - 1];
    assert(last.action === 'record.update', `最后一条应是修改，实际 ${last.action}`);
    const detail = JSON.parse(last.detail);
    assert(Number(detail.before['原值(元)']) === 2000, `改前应为 2000，实际 ${detail.before['原值(元)']}`);
    assert(Number(detail.after['原值(元)']) === 3000, `改后应为 3000，实际 ${detail.after['原值(元)']}`);
    await admin(`/api/modules/facility/records/${encodeURIComponent(id)}`, { method: 'DELETE' });
  });
  await check('模块筛选与 recId 筛选可以叠加', async () => {
    const r = await admin('/api/audit?module=levy&recId=nonexistent_id_xyz');
    assert(r.status === 200, JSON.stringify(r.data));
    assert(r.data.rows.length === 0, `不存在的记录应返回空，实际 ${r.data.rows.length}`);
  });

  console.log('\n并发与传输：');  await check('版本号过期的修改被拒绝（409 rev_conflict）', async () => {
    // 多人共享账套是这个系统的主要用途。没有这一层的话，两个人同时打开同一条记录，
    // 后点保存的人会把前一个人的修改整条盖掉，双方都看不到任何提示。
    const created = await admin('/api/modules/facility/records', {
      method: 'POST',
      // 此时受控清单已经建立，「单位」是必填且必须在清单里——这正是本次修复要求的
      body: { properties: { 单位: { text: '第一公司' }, 设施名称: { text: '并发样本' }, '原值(元)': { number: 1000 } } },
    });
    assert(created.status === 201, JSON.stringify(created.data));
    const id = created.data.record._id;
    const rev = created.data.record._rev;
    const first = await admin(`/api/modules/facility/records/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { rev, properties: { '原值(元)': { number: 2000 } } },
    });
    assert(first.status === 200, `第一次修改应成功：${JSON.stringify(first.data)}`);
    assert(first.data.record._rev === rev + 1, `版本号应递增，实际 ${first.data.record._rev}`);
    const stale = await admin(`/api/modules/facility/records/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { rev, properties: { '原值(元)': { number: 9999 } } },
    });
    assert(stale.status === 409, `带旧版本号应 409，实际 ${stale.status}`);
    assert(stale.data.code === 'rev_conflict', `应带 rev_conflict 标识：${JSON.stringify(stale.data)}`);
    const now = await admin(`/api/modules/facility/records`);
    const still = now.data.results.find((x) => x._id === id);
    assert(Number(still['原值(元)']) === 2000, `第一次的修改不应被覆盖，实际 ${still['原值(元)']}`);
    await admin(`/api/modules/facility/records/${encodeURIComponent(id)}`, { method: 'DELETE' });
  });
  await check('不带版本号的修改仍然放行（兼容脚本调用）', async () => {
    const created = await admin('/api/modules/facility/records', {
      method: 'POST',
      body: { properties: { 单位: { text: '第一公司' }, 设施名称: { text: '兼容样本' } } },
    });
    const id = created.data.record._id;
    const r = await admin(`/api/modules/facility/records/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { properties: { 设施名称: { text: '兼容样本2' } } },
    });
    assert(r.status === 200, `不带 rev 应放行：${JSON.stringify(r.data)}`);
    await admin(`/api/modules/facility/records/${encodeURIComponent(id)}`, { method: 'DELETE' });
  });
  await check('响应支持 gzip 压缩（带宽是现场的真实瓶颈）', async () => {
    const resp = await fetch(`${BASE}/app.css`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert(resp.status === 200, `HTTP ${resp.status}`);
    assert((resp.headers.get('content-encoding') || '') === 'gzip', `应返回 gzip，实际 ${resp.headers.get('content-encoding')}`);
    assert((resp.headers.get('vary') || '').toLowerCase().includes('accept-encoding'), '必须带 Vary: Accept-Encoding，否则代理会把压缩体喂给不支持的客户端');
  });
  await check('不支持压缩的客户端拿到原文', async () => {
    const resp = await fetch(`${BASE}/app.css`, { headers: { 'Accept-Encoding': 'identity' } });
    assert(resp.status === 200, `HTTP ${resp.status}`);
    assert(!resp.headers.get('content-encoding'), `不该压缩，实际 ${resp.headers.get('content-encoding')}`);
  });
  await check('localhost 的两个协议栈都能连上（IPv4 + IPv6 回环）', async () => {
    /*
     * 真实故障：服务在跑、curl 127.0.0.1 通，但浏览器打开 http://localhost:PORT
     * 直接「无法访问」。现代浏览器解析 localhost 时优先取 IPv6 的 ::1，
     * 而 Node 只在传入的那一个地址上监听，不会因为两者都叫 localhost 就同时接管。
     */
    if (EXTERNAL_BASE) return;   // 外部实例的监听地址不由我们决定
    const v4 = await fetch(`http://127.0.0.1:${PORT}/api/health`);
    assert(v4.status === 200, `IPv4 期望 200，实际 ${v4.status}`);
    let v6Status = 0;
    try {
      v6Status = (await fetch(`http://[::1]:${PORT}/api/health`)).status;
    } catch (err) {
      // 环境完全没有 IPv6 栈时连不上是正常的，不该判失败
      const noStack = /EAFNOSUPPORT|EADDRNOTAVAIL|ENETUNREACH/.test(String(err.cause?.code || err.message));
      assert(noStack, `IPv6 回环连接失败：${err.cause?.code || err.message}`);
      return;
    }
    assert(v6Status === 200, `IPv6 期望 200，实际 ${v6Status}`);
  });
  await check('畸形 Cookie 不再让整站 500', async () => {
    // 曾经的表现：一个坏 Cookie（fin_sid=%）让每个请求包括首页都 500，
    // 浏览器会一直把它发回来，用户完全无法自行恢复
    for (const path of ['/api/me', '/']) {
      const resp = await fetch(BASE + path, { headers: { Cookie: 'fin_sid=%' } });
      assert(resp.status < 500, `${path} 期望非 5xx，实际 ${resp.status}`);
    }
  });
  await check('畸形 URL 编码返回 400 而不是 500', async () => {
    const resp = await fetch(`${BASE}/%ZZ.js`);
    assert(resp.status === 400, `期望 400，实际 ${resp.status}`);
  });
  await check('匿名健康检查不泄露账套规模', async () => {
    // /api/health 无需登录（给探针用），端口一旦误暴露就会把每个模块的记录数交出去
    const resp = await fetch(`${BASE}/api/health?detail=1`);
    const data = await resp.json();
    assert(resp.status === 200 && data.ok === true, JSON.stringify(data));
    assert(data.records === undefined, `匿名不应看到记录数：${JSON.stringify(data)}`);
  });
  await check('管理员可以看到健康检查明细', async () => {
    const r = await admin('/api/health?detail=1');
    assert(r.status === 200 && r.data.records && typeof r.data.records.facility === 'number', JSON.stringify(r.data).slice(0, 120));
  });
  await check('最后一个管理员不能自我降级或被停用', async () => {
    // 管理权限归零后 /api/users 全部 403，再也改不回来，
    // 只能停服跑 CLI，而 reset-password 只能改口令不能改角色
    const demote = await admin(`/api/users/${encodeURIComponent(ADMIN.username)}`, { method: 'PATCH', body: { role: 'viewer' } });
    assert(demote.status === 400, `自我降级应被拒，实际 ${demote.status}：${JSON.stringify(demote.data)}`);
    const off = await admin(`/api/users/${encodeURIComponent(ADMIN.username)}`, { method: 'DELETE' });
    assert(off.status === 400, `停用自己应被拒，实际 ${off.status}`);
    const me2 = await admin('/api/me');
    assert(me2.data.user.role === 'admin', `角色不该被改动，实际 ${me2.data.user.role}`);
  });

  await check('换用户名不能绕过登录限流', async () => {
    /*
     * 原来的限流键是「用户名@IP」，于是换个用户名计数就重置——
     * 对同一台机器上的账号枚举完全无效。现在同一 IP 的失败次数会单独累计。
     */
    const probe = makeClient();
    let blocked = false;
    for (let i = 0; i < config_loginMax * 2 + 4; i += 1) {
      const r = await probe('/api/login', { method: 'POST', body: { username: `nobody_${i}`, password: 'WrongPass123' } });
      if (r.status === 429) { blocked = true; break; }
    }
    assert(blocked, `连续换用户名尝试应触发 429，实际全部返回 401`);
  });

  /* ---------- 模块显隐自选 与 界面自定义模块 ---------- */

  await check('保存模块显隐偏好并回读', async () => {
    const save = await admin('/api/prefs/modules', { method: 'POST', body: { hidden: ['machinery'] } });
    assert(save.status === 200 && save.data.ok, JSON.stringify(save.data));
    const me = await admin('/api/me');
    assert((me.data.hiddenModules || []).includes('machinery'), JSON.stringify(me.data.hiddenModules));
  });
  await check('显隐偏好里未知模块被过滤', async () => {
    const save = await admin('/api/prefs/modules', { method: 'POST', body: { hidden: ['machinery', 'not_a_module'] } });
    assert(save.status === 200, JSON.stringify(save.data));
    assert(!save.data.hidden.includes('not_a_module'), '未知模块 key 不应被记住');
    await admin('/api/prefs/modules', { method: 'POST', body: { hidden: [] } });
  });

  let customKey = '';
  await check('管理员创建自定义模块并进入 schema', async () => {
    const r = await admin('/api/modules-custom', {
      method: 'POST',
      body: {
        name: '示例自定义模块',
        monthly: true,
        fields: [
          { name: '事项', type: 'text', required: true },
          { name: '金额(元)', type: 'number' },
          { name: '类别', type: 'select', options: ['日常', '临时'] },
        ],
      },
    });
    assert(r.status === 201 && r.data.ok, JSON.stringify(r.data).slice(0, 150));
    customKey = r.data.module.key;
    assert(String(customKey).startsWith('custom_'), `key 应以 custom_ 开头：${customKey}`);
    const schema = await admin('/api/schema');
    const found = (schema.data.modules || []).find((m) => m.databaseId === customKey);
    assert(!!found, '自定义模块应出现在 /api/schema');
    assert(found.properties.some((p) => p.name === '会计期间'), '按月模块应自动带会计期间字段');
    assert(found.properties.some((p) => p.name === '单位'), '应自动带单位字段');
  });
  await check('重复模块名被拒绝（400）', async () => {
    const r = await admin('/api/modules-custom', {
      method: 'POST',
      body: { name: '示例自定义模块', monthly: false, fields: [{ name: '事项', type: 'text' }] },
    });
    assert(r.status === 400, `期望 400，实际 ${r.status}：${JSON.stringify(r.data)}`);
  });
  await check('select 字段缺选项被拒绝（400）', async () => {
    const r = await admin('/api/modules-custom', {
      method: 'POST',
      body: { name: '另一个模块', monthly: false, fields: [{ name: '类别', type: 'select' }] },
    });
    assert(r.status === 400, `期望 400，实际 ${r.status}：${JSON.stringify(r.data)}`);
  });
  await check('只读账号不能新建模块（403）', async () => {
    const r = await viewer('/api/modules-custom', {
      method: 'POST',
      body: { name: '越权模块', monthly: false, fields: [{ name: '事项', type: 'text' }] },
    });
    assert(r.status === 403, `期望 403，实际 ${r.status}`);
  });
  await check('自定义模块可录入，未知字段被丢弃', async () => {
    const create = await admin(`/api/modules/${customKey}/records`, {
      method: 'POST',
      body: {
        properties: {
          单位: { text: '第一公司' },
          事项: { text: '测试事项' },
          会计期间: { date: '2026-04-01' },
          '金额(元)': { number: 123.45 },
          类别: { select: '日常' },
        },
      },
    });
    assert(create.status === 201, JSON.stringify(create.data).slice(0, 150));
    assert(create.data.record['金额(元)'] === 123.45, '数字字段应落库');
    const bad = await admin(`/api/modules/${customKey}/records`, {
      method: 'POST',
      body: {
        properties: {
          单位: { text: '第一公司' },
          事项: { text: '未知字段测试' },
          不存在的字段: { text: 'x' },
          会计期间: { date: '2026-04-01' },
        },
      },
    });
    assert(bad.status === 201, `未知字段应丢弃而非报错：${JSON.stringify(bad.data).slice(0, 120)}`);
    assert(bad.data.record['不存在的字段'] === undefined, '未知字段不应落库');
    assert((bad.data.ignoredFields || []).includes('不存在的字段'), '未知字段应反馈在 ignoredFields 里');
  });
  await check('有数据的自定义模块不能删除', async () => {
    const r = await admin(`/api/modules-custom/${customKey}`, { method: 'DELETE' });
    assert(r.status >= 400, `应拒绝删除，实际 ${r.status}：${JSON.stringify(r.data)}`);
  });
  await check('清空数据后可删除自定义模块', async () => {
    const clear = await admin(`/api/modules/${customKey}/records`, { method: 'DELETE' });
    assert(clear.status === 200, JSON.stringify(clear.data));
    const del = await admin(`/api/modules-custom/${customKey}`, { method: 'DELETE' });
    assert(del.status === 200, JSON.stringify(del.data));
    const schema = await admin('/api/schema');
    assert(!(schema.data.modules || []).some((m) => m.databaseId === customKey), '删除后不应再出现在 schema');
  });

  await check('退出登录后会话失效', async () => {
    const out = await admin('/api/logout', { method: 'POST' });
    assert(out.status === 200, `HTTP ${out.status}`);
    const after = await admin('/api/modules/facility/records');
    assert(after.status === 401, `期望 401，实际 ${after.status}`);
  });
} catch (err) {
  fail('自检脚本异常', err.message);
  console.error(err);
} finally {
  console.log('\n' + '='.repeat(52));
  if (failures.length) {
    console.log(`结果：${passed} 项通过，${failures.length} 项失败`);
    for (const f of failures) console.log(`  ✗ ${f}`);
    if (serverLog) console.log('\n服务器日志：\n' + serverLog);
  } else {
    console.log(`结果：全部 ${passed} 项通过`);
  }
  console.log('='.repeat(52) + '\n');
  cleanup();
  setTimeout(() => process.exit(failures.length ? 1 : 0), 600);
}
