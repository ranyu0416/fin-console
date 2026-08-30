#!/usr/bin/env node
/**
 * 构建产物校验：确认 public/ 结构完整、脚本引用的元素 id 都在 index.html 里。
 * 单页 HTML 拆分后最容易出的错是漏搬某个节点，导致脚本运行时拿到 null。
 *   node scripts/verify-build.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PUBLIC = join(ROOT, 'public');

const problems = [];

/* ---------- 1. 必需文件 ---------- */
const REQUIRED = ['index.html', 'app.css', 'bridge.js', 'admin.js', 'app/main.js'];
for (const f of REQUIRED) {
  if (!existsSync(join(PUBLIC, f))) problems.push(`缺少产物文件 ${f}`);
}
if (problems.length) {
  console.log('发现问题：');
  for (const p of problems) console.log(`  ✗ ${p}`);
  console.log('\n请先执行 npm run build。');
  process.exit(1);
}

const html = readFileSync(join(PUBLIC, 'index.html'), 'utf8');
const bridge = readFileSync(join(PUBLIC, 'bridge.js'), 'utf8');
const admin = readFileSync(join(PUBLIC, 'admin.js'), 'utf8');

/* ---------- 2. 收集所有台账模块 ---------- */
const appFiles = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.name.endsWith('.js')) appFiles.push(p);
  }
})(join(PUBLIC, 'app'));

const appSrc = appFiles.map((f) => readFileSync(f, 'utf8')).join('\n');

/* ---------- 3. 元素 id 引用闭合 ---------- */
const htmlIds = new Set();
for (const m of html.matchAll(/\sid="([^"]+)"/g)) htmlIds.add(m[1]);

const appIds = new Set();
for (const m of appSrc.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)) appIds.add(m[1]);
for (const m of appSrc.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)) appIds.add(m[1]);

const shellIds = new Set();
for (const src of [bridge, admin]) {
  for (const m of src.matchAll(/\bel\('([A-Za-z0-9_-]+)'\)/g)) shellIds.add(m[1]);
  for (const m of src.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)) shellIds.add(m[1]);
}

// 运行时生成，或「存在即绑定」的可选节点
const DYNAMIC_IDS = new Set([
  'preview', 'btnClearModule', 'btnChangePwd', 'btnLogout',
]);

// 脚本自己用模板字符串生成的节点（面板内容）也算已定义：从 JS 里的 id="xxx" 收集
for (const src of [appSrc, bridge, admin]) {
  for (const m of src.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)) DYNAMIC_IDS.add(m[1]);
  for (const m of src.matchAll(/\bid="'\s*\+/g)) void m; // 拼接出来的 id 无法静态确定，忽略
}

for (const id of [...appIds].sort()) {
  if (!htmlIds.has(id) && !DYNAMIC_IDS.has(id)) problems.push(`台账模块引用了不存在的元素 #${id}`);
}
for (const id of [...shellIds].sort()) {
  if (!htmlIds.has(id) && !DYNAMIC_IDS.has(id)) problems.push(`外壳脚本引用了不存在的元素 #${id}`);
}

/* ---------- 4. 关键结构 ---------- */
const MUST_HAVE_IN_HTML = [
  ['app.css', '样式表引用'],
  ['bridge.js', '桥接脚本引用'],
  ['admin.js', '管理脚本引用'],
  ['id="authOverlay"', '登录层'],
  ['id="adminMask"', '管理面板'],
  ['id="unitOptions"', '单位建议列表'],
  ['id="printArea"', '打印容器'],
  ['id="overviewCard"', '总览卡片'],
];
for (const [needle, label] of MUST_HAVE_IN_HTML) {
  if (!html.includes(needle)) problems.push(`index.html 缺少${label}（${needle}）`);
}

// index.html 不应含内联 <script>（与 CSP script-src 'self' 冲突），也不该残留旧引用
const withoutSrcScripts = html.replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, '');
if (/<script(?![^>]*\bsrc=)/.test(withoutSrcScripts)) {
  problems.push("index.html 含内联 <script>，与 CSP script-src 'self' 冲突");
}
if (html.includes('page_comm/inject.js')) problems.push('index.html 仍引用 WorkBuddy 的 inject.js');
if (/src="app\.js"/.test(html)) problems.push('index.html 仍引用已废弃的单文件 app.js');

/* ---------- 5. 模块图完整性 ---------- */
/*
 * 要检查哪些模块，从 registry.js 的 import 语句里读出来，不再手抄一份清单。
 * 手抄的清单在新增模块时漏改不会失败，只会静默少检一个模块——
 * 而这一步的全部价值就在于「漏搬文件、漏加页签」能当场被发现。
 */
const registrySrc = readFileSync(join(PUBLIC, 'app', 'modules', 'registry.js'), 'utf8');
const moduleKeys = [...registrySrc.matchAll(/from\s+'\.\/([A-Za-z0-9_-]+)\.js'/g)].map((m) => m[1]);
if (!moduleKeys.length) problems.push('app/modules/registry.js 里读不到任何模块 import，无法校验模块图');
for (const key of moduleKeys) {
  if (!existsSync(join(PUBLIC, 'app', 'modules', `${key}.js`))) problems.push(`缺少模块文件 app/modules/${key}.js`);
  if (!html.includes(`data-mod="${key}"`)) problems.push(`index.html 缺少模块页签 ${key}`);
}

// bridge.js 必须以模块方式加载入口
if (!bridge.includes("s.type = 'module'")) problems.push('bridge.js 未以 type="module" 加载台账入口');
if (!bridge.includes('app/main.js')) problems.push('bridge.js 未加载 app/main.js');

// 台账模块不应直接使用 localStorage（统一走 core/env.js 的 FIN_STORE）
for (const f of appFiles) {
  const rel = relative(PUBLIC, f).replace(/\\/g, '/');
  if (rel === 'app/core/env.js') continue;
  if (/\blocalStorage\b/.test(readFileSync(f, 'utf8'))) {
    problems.push(`${rel} 直接使用了 localStorage，应改用 FIN_STORE`);
  }
}

/* ---------- 输出 ---------- */
const totalKb = appFiles.reduce((n, f) => n + statSync(f).size, 0) / 1024;
console.log(
  `[verify] index.html 元素 ${htmlIds.size} 个；台账 ${appFiles.length} 个模块（${totalKb.toFixed(1)} KB）；` +
    `引用 ${appIds.size} + ${shellIds.size} 个元素`,
);
if (problems.length) {
  console.log('\n发现问题：');
  for (const p of [...new Set(problems)]) console.log(`  ✗ ${p}`);
  process.exit(1);
}
console.log('[verify] 通过：构建产物结构完整');
