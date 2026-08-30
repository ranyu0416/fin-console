#!/usr/bin/env node
/**
 * 前端构建：把 frontend/ 的源文件复制到 public/。
 *
 * 拆成 ES 模块之后，构建只剩「复制 + 统计」，不再有任何文本补丁：
 * 源文件本身就是最终运行的代码，改哪一行就是哪一行，报错能直接定位。
 *   node scripts/build-frontend.mjs
 */
import { cpSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SRC = join(ROOT, 'frontend');
const OUT = join(ROOT, 'public');

// [源, 目标]。目录整体复制，文件单独复制。
const COPY = [
  ['index.html', 'index.html'],
  ['bridge.js', 'bridge.js'],
  ['admin.js', 'admin.js'],
  ['styles/app.css', 'app.css'],
  ['app', 'app'],
];

console.log(`[build] 源目录：${SRC}`);
console.log(`[build] 输出目录：${OUT}`);

// 每次全量重建，避免已删除的模块残留在 public 里
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

let files = 0;
let bytes = 0;

function countTree(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) countTree(p);
    else { files += 1; bytes += statSync(p).size; }
  }
}

for (const [from, to] of COPY) {
  const src = join(SRC, from);
  const dest = join(OUT, to);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
  const st = statSync(src);
  if (st.isDirectory()) {
    const before = files;
    countTree(src);
    console.log(`[build] ${from.padEnd(14)} → ${to}/  （${files - before} 个模块）`);
  } else {
    files += 1;
    bytes += st.size;
    console.log(`[build] ${from.padEnd(14)} → ${to}`);
  }
}

// 构建号：页面每分钟核对一次（main.js），检测到新构建就提示刷新——
// 静态资源没有内容哈希，浏览器 5 分钟缓存窗口内可能新旧模块混搭，宁可多提示一次刷新
writeFileSync(join(OUT, 'build-id.json'), JSON.stringify({ id: new Date().toISOString() }));

console.log(`[build] 完成：${files} 个文件，${(bytes / 1024).toFixed(1)} KB`);
