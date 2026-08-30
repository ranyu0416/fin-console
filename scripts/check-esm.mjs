#!/usr/bin/env node
/**
 * ESM 静态检查：在 Node 里把 frontend/app 当作模块图走一遍，
 * 检查 import 路径存在、导入的符号确实被导出、没有重复声明、没有未定义的裸标识符。
 * 不需要浏览器，跑得快，适合每次改完立刻验证。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..', 'frontend', 'app');
const ENTRY = join(APP, 'main.js');

const problems = [];
const seen = new Map(); // 绝对路径 -> { exports:Set, imports:[{from,names}] }

function parse(file) {
  if (seen.has(file)) return seen.get(file);
  if (!existsSync(file)) {
    problems.push(`文件不存在：${relative(APP, file)}`);
    seen.set(file, { exports: new Set(), imports: [] });
    return seen.get(file);
  }
  const src = readFileSync(file, 'utf8');
  const exports = new Set();
  const imports = [];

  for (const m of src.matchAll(/^export (?:function|async function) ([A-Za-z_$][\w$]*)/gm)) exports.add(m[1]);
  for (const m of src.matchAll(/^export (?:const|let|var) ([A-Za-z_$][\w$]*)/gm)) exports.add(m[1]);
  for (const m of src.matchAll(/^export \{([^}]+)\}/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) exports.add(name);
    }
  }

  for (const m of src.matchAll(/^import \{([^}]+)\} from '([^']+)';/gm)) {
    imports.push({
      names: m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean),
      from: m[2],
      raw: m[0],
    });
  }
  // 副作用导入
  for (const m of src.matchAll(/^import '([^']+)';/gm)) imports.push({ names: [], from: m[1], raw: m[0] });

  const rec = { exports, imports, src, file };
  seen.set(file, rec);

  for (const imp of imports) {
    if (!imp.from.startsWith('.')) {
      problems.push(`${relative(APP, file)}：不支持的裸模块说明符 '${imp.from}'`);
      continue;
    }
    parse(resolve(dirname(file), imp.from));
  }
  return rec;
}

parse(ENTRY);

// 检查每个 import 的符号确实被目标导出
for (const [file, rec] of seen) {
  for (const imp of rec.imports || []) {
    if (!imp.from.startsWith('.')) continue;
    const target = resolve(dirname(file), imp.from);
    const t = seen.get(target);
    if (!t) continue;
    for (const name of imp.names) {
      if (!t.exports.has(name)) {
        problems.push(`${relative(APP, file)}：从 ${imp.from} 导入的 ${name} 未被导出`);
      }
    }
  }
}

// 重复声明与自引
for (const [file, rec] of seen) {
  if (!rec.src) continue;
  const declared = new Map();
  for (const m of rec.src.matchAll(/^(?:export )?(?:function|async function) ([A-Za-z_$][\w$]*)/gm)) {
    declared.set(m[1], (declared.get(m[1]) || 0) + 1);
  }
  for (const m of rec.src.matchAll(/^(?:export )?(?:const|let|var) ([A-Za-z_$][\w$]*)/gm)) {
    declared.set(m[1], (declared.get(m[1]) || 0) + 1);
  }
  const imported = new Set();
  for (const imp of rec.imports) for (const n of imp.names) imported.add(n);
  for (const [name, count] of declared) {
    if (count > 1) problems.push(`${relative(APP, file)}：${name} 重复声明 ${count} 次`);
    if (imported.has(name)) problems.push(`${relative(APP, file)}：${name} 既 import 又本地声明`);
  }
  for (const imp of rec.imports) {
    if (resolve(dirname(file), imp.from) === file) {
      problems.push(`${relative(APP, file)}：自己 import 自己`);
    }
  }
}

// 未定义标识符：收集所有已知名字，扫描疑似漏 import 的调用
const GLOBALS = new Set([
  'window', 'document', 'console', 'Math', 'Number', 'String', 'Boolean', 'Object', 'Array', 'JSON', 'Date',
  'Blob', 'URL', 'FileReader', 'RegExp', 'Error', 'Promise', 'Set', 'Map', 'isNaN', 'parseFloat', 'parseInt',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'confirm', 'alert', 'prompt', 'fetch',
  'encodeURIComponent', 'decodeURIComponent', 'Uint8Array', 'Uint32Array', 'ArrayBuffer', 'TextEncoder',
  'Intl', 'HTMLAnchorElement', 'Event', 'CustomEvent', 'DOMParser', 'requestAnimationFrame', 'undefined',
  'NaN', 'Infinity', 'globalThis', 'structuredClone', 'crypto', 'localStorage', 'sessionStorage', 'location',
  'isFinite', 'Symbol', 'Proxy', 'Reflect', 'WeakMap', 'WeakSet', 'BigInt', 'Function', 'queueMicrotask',
]);

for (const [file, rec] of seen) {
  if (!rec.src) continue;
  const known = new Set([...GLOBALS, ...rec.exports]);
  for (const imp of rec.imports) for (const n of imp.names) known.add(n);
  // 本地声明（含函数参数与 var/let/const，粗粒度）
  for (const m of rec.src.matchAll(/(?:function|catch)\s*\(?\s*([A-Za-z_$][\w$]*)?/g)) if (m[1]) known.add(m[1]);
  for (const m of rec.src.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$,\s]*)/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/[=\s]/)[0];
      if (n) known.add(n);
    }
  }
  for (const m of rec.src.matchAll(/function[^(]*\(([^)]*)\)/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/[=\s]/)[0];
      if (n) known.add(n);
    }
  }
  for (const m of rec.src.matchAll(/\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>/g)) known.add(m[1]);
  for (const m of rec.src.matchAll(/\bfor\s*\(\s*(?:var|let|const)?\s*([A-Za-z_$][\w$]*)/g)) known.add(m[1]);

  // 只检查「像函数调用」的裸标识符，避免误报属性名与字符串
  const calls = new Set();
  // 注意顺序：先去字符串，再去注释（此时注释里不会再有引号干扰）
  const stripped = rec.src
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  for (const m of stripped.matchAll(/(?<![\w$.])([a-z_$][\w$]*)\s*\(/g)) calls.add(m[1]);
  const RESERVED = new Set(['if', 'for', 'while', 'switch', 'return', 'typeof', 'catch', 'function', 'new', 'delete', 'void', 'in', 'of', 'do', 'else', 'try', 'throw', 'case', 'await', 'yield']);
  for (const name of calls) {
    if (RESERVED.has(name) || known.has(name)) continue;
    problems.push(`${relative(APP, file)}：调用了未定义/未导入的 ${name}()`);
  }
}

console.log(`[esm] 模块图 ${seen.size} 个文件，入口 main.js`);
if (problems.length) {
  console.log('\n发现问题：');
  for (const p of [...new Set(problems)]) console.log(`  ✗ ${p}`);
  process.exit(1);
}
console.log('[esm] 通过：import/export 闭合，无重复声明与漏引用');
