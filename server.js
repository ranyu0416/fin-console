/**
 * 财务管理台服务端入口。
 * 只用 Node 内置模块：node:http 提供 HTTP，node:sqlite 提供持久化。
 * 启动：node server.js（配置见 lib/config.js 与 config.example.json）
 */
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { config } from './lib/config.js';
import { closeDb } from './lib/db.js';
import {
  SESSION_COOKIE,
  createUser,
  listUsers,
  purgeExpiredSessions,
  purgeOldLoginAttempts,
  readSession,
  touchSession,
} from './lib/auth.js';
import { startBackupSchedule } from './lib/backup.js';
import {
  HttpError,
  clientIp,
  cookieHeader,
  indexFile,
  negotiateEncoding,
  parseCookies,
  sendJson,
  sendText,
  serveStatic,
} from './lib/http.js';
import { loadCustomModules } from './lib/custom_modules.js';
import { handleApi } from './lib/routes.js';
import { audit, purgeAudit } from './lib/store.js';

/* ---------------- 首启动引导：创建管理员 ---------------- */

function bootstrapAdmin() {
  if (listUsers().length > 0) return;
  const username = config.bootstrapAdminUser;
  let password = config.bootstrapAdminPassword;
  let generated = false;
  if (!password) {
    // 未提供初始口令时生成一个随机强口令并打印一次，强制首登修改
    password = `Fin${Math.random().toString(36).slice(2, 8)}${Math.floor(Math.random() * 90 + 10)}`;
    generated = true;
  }
  try {
    createUser({ username, password, displayName: '系统管理员', role: 'admin', mustChange: 1 });
  } catch (err) {
    console.error(`[bootstrap] 创建管理员失败：${err.message}`);
    console.error('[bootstrap] 请设置符合要求的 FIN_ADMIN_PASSWORD（至少 8 位，含字母和数字）后重启。');
    process.exit(1);
  }
  console.log('');
  console.log('==================================================');
  console.log('  首次启动：已创建管理员账号');
  console.log(`  账号：${username}`);
  console.log(`  口令：${generated ? password : '（使用 FIN_ADMIN_PASSWORD 指定的口令）'}`);
  console.log('  首次登录后必须修改口令。');
  console.log('==================================================');
  console.log('');
  audit({ actor: 'system', action: 'bootstrap.admin', detail: username });
}

bootstrapAdmin();

/* 界面自定义模块：定义存 settings，重启后在这里重放注册 */
loadCustomModules();

/* ---------------- 定期清理 ---------------- */

const cleanupTimer = setInterval(() => {
  try {
    purgeExpiredSessions();
    purgeOldLoginAttempts();
    purgeAudit(730);
  } catch (err) {
    console.error(`[cleanup] 清理失败：${err.message}`);
  }
}, 3600 * 1000);
cleanupTimer.unref?.();

const stopBackup = startBackupSchedule();

/* ---------------- 请求处理 ---------------- */

/*
 * 请求处理函数单独命名，因为下面可能会创建两个 Server（IPv4 + IPv6 回环）
 * 共用它——见 listen 那一段的说明。
 */
async function handleRequest(req, res) {
  const started = Date.now();
  let ctx = null;
  try {
    // 先协商响应编码，后面所有 send* 都据此决定是否 gzip
    negotiateEncoding(req, res);

    let url;
    try {
      url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    } catch {
      // 畸形请求行不该变成 500——那只会在日志里堆一堆看不出原因的栈
      throw new HttpError(400, '请求地址非法');
    }
    const path = url.pathname.replace(/\/{2,}/g, '/');
    const method = (req.method || 'GET').toUpperCase();

    const cookies = parseCookies(req);
    const session = readSession(cookies[SESSION_COOKIE]);
    ctx = { req, res, url, path, method, session };

    if (session) {
      const renewed = touchSession(session.token);
      if (renewed) {
        res.setHeader('Set-Cookie', cookieHeader(SESSION_COOKIE, session.token, { maxAgeSeconds: config.sessionHours * 3600 }));
      }
    }

    if (path.startsWith('/api/')) {
      await handleApi(ctx);
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') {
      throw new HttpError(405, 'Method Not Allowed');
    }

    if (serveStatic(req, res, path)) return;

    // 静态资源未命中就直接 404：不要回落到首页，否则缺失的 .js/.css 会拿到一份 HTML，
    // 浏览器报的是难查的语法错误而不是清晰的 404。
    if (/\.[a-z0-9]+$/i.test(path)) {
      sendText(res, 404, `资源不存在：${path}\n若刚改过前端，请重新执行 npm run build。`);
      return;
    }

    // 其余路径回落到首页（单页应用路由）
    if (existsSync(indexFile())) {
      if (serveStatic(req, res, '/index.html')) return;
    }
    sendText(res, 404, '页面不存在。请先执行 npm run build 生成 public 目录。');
  } catch (err) {
    const status = Number(err?.status) || 500;
    if (status >= 500) {
      console.error(`[http] ${req.method} ${req.url} -> ${status}`, err);
    }
    if (!res.headersSent) {
      sendJson(res, status, {
        error: status >= 500 ? '服务器内部错误' : err.message || '请求失败',
        code: err?.code || '',
      });
    } else {
      res.end();
    }
    if (status >= 500 && ctx?.session) {
      try {
        audit({
          actor: ctx.session.user.username,
          ip: clientIp(req),
          action: 'error',
          detail: `${req.method} ${req.url}: ${err.message}`,
        });
      } catch {
        /* 审计失败不影响响应 */
      }
    }
  } finally {
    const ms = Date.now() - started;
    if (ms > 1000) console.warn(`[http] 慢请求 ${req.method} ${req.url} ${ms}ms`);
  }
}

const server = createServer(handleRequest);

server.headersTimeout = 30_000;
server.requestTimeout = 120_000;

/*
 * 监听 127.0.0.1 时额外再监听一次 ::1。
 *
 * 起因是一个真实故障：服务好好地跑着，curl 127.0.0.1 通，但浏览器打开
 * http://localhost:8787 直接「无法访问」。原因是现代浏览器解析 localhost 时
 * 优先取 IPv6 的 ::1，而 Node 只在传入的那一个地址上监听——它不会因为
 * 127.0.0.1 和 ::1 都叫 localhost 就同时接管两个协议栈。
 *
 * 为什么不干脆监听 '::'：那等于监听所有网卡（IPv4 也会被映射进去），
 * 把本该只给本机的服务暴露到局域网，和 FIN_HOST=127.0.0.1 的意图相反。
 *
 * 所以只在「用户明确要求只给本机」时补一个 IPv6 回环监听：两个监听器共用
 * 同一个请求处理函数、同一个数据库，对外就是同一个服务。
 * 系统没有 IPv6 时绑定会失败，那不是错误，静默跳过即可。
 */
const LOOPBACK_V4 = ['127.0.0.1', 'localhost'];
let serverV6 = null;
if (LOOPBACK_V4.includes(config.host)) {
  serverV6 = createServer(handleRequest);
  serverV6.headersTimeout = 30_000;
  serverV6.requestTimeout = 120_000;
  serverV6.on('error', (err) => {
    // 端口被占是真问题，要说出来；没有 IPv6 栈（EADDRNOTAVAIL/EAFNOSUPPORT）则无所谓
    if (err.code === 'EADDRINUSE') {
      console.warn(`[server] IPv6 回环 [::1]:${config.port} 已被占用，localhost 可能打不开；请改用 127.0.0.1`);
    }
    serverV6 = null;
  });
  serverV6.listen(config.port, '::1');
}

server.on('error', (err) => {
  /*
   * 主监听必须有自己的 error 处理：端口被占时 Node 的默认行为是
   * 抛未处理异常直接退出（exit 1），屏幕上只有一行 nobody 读得懂的栈——
   * 真实场景是「已经有一个实例在跑，又双击了一次启动脚本」，
   * 要说的是人话：不要重复启动，直接用浏览器访问即可。
   */
  if (err.code === 'EADDRINUSE') {
    console.error(`[server] 端口 ${config.port} 已被占用——很可能已有一个财务管理台实例正在运行。`);
    console.error('[server] 不要重复启动，直接用浏览器访问 http://localhost:' + config.port + ' 即可。');
    process.exit(1);
  }
  console.error('[server] 监听失败：', err);
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  const shown = config.host === '0.0.0.0' ? '<本机所有网卡>' : config.host;
  console.log(`[server] 财务管理台已启动：http://${shown}:${config.port}`);
  if (LOOPBACK_V4.includes(config.host)) {
    console.log(`[server] 浏览器请访问：http://localhost:${config.port}  或  http://127.0.0.1:${config.port}`);
  }
  console.log(`[server] 数据目录：${config.dataDir}`);
  console.log(`[server] 前端目录：${config.publicDir}`);
  if (!existsSync(indexFile())) {
    console.warn('[server] 未找到 public/index.html —— 请先执行 npm run build');
  }
  if (config.host === '0.0.0.0' && !config.cookieSecure) {
    console.warn('[server] 提示：已监听所有网卡但 Cookie 未启用 Secure；建议在 HTTPS 反向代理后运行并设置 FIN_COOKIE_SECURE=1');
  }
});

/* ---------------- 优雅退出 ---------------- */

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`[server] 收到 ${signal}，正在关闭…`);
  clearInterval(cleanupTimer);
  stopBackup();
  // IPv6 回环监听器也要收，否则进程不会退出（它还持有一个打开的 handle）
  if (serverV6) {
    try { serverV6.close(); } catch { /* 已经关了 */ }
  }
  server.close(() => {
    try {
      closeDb();
    } catch (err) {
      console.error(`[server] 关闭数据库出错：${err.message}`);
    }
    console.log('[server] 已安全退出');
    process.exit(0);
  });
  // 兜底：10 秒内没关完就强退，避免 systemd 一直等
  setTimeout(() => process.exit(0), 10_000).unref?.();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => console.error('[server] 未处理的 Promise 拒绝：', err));
