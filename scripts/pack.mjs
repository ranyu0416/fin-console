#!/usr/bin/env node
/**
 * 打包发布件。
 *
 * 产出两个文件放到 dist/：
 *   fin-console-<版本>.tar.gz   Linux / WSL / Docker 用
 *   fin-console-<版本>.zip      Windows Server 用（自带 zip，不依赖系统 zip 命令）
 *
 * 刻意包含 public/：它虽然是构建产物，但目标机器上不一定愿意跑构建，
 * 而这个项目的「构建」只是复制文件，把结果一起带走没有任何坏处。
 * 打包前会强制重新构建一次，避免把过期产物发出去。
 *
 * 刻意排除：data/ data-demo/（账套数据）、config.json（可能含口令）、
 * .git/、日志、run/。发布件里不应该有任何一台具体机器的痕迹。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, gzipSync, crc32 } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DIST = join(ROOT, 'dist');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const VERSION = process.argv[2] || pkg.version || '1.0.0';
const NAME = `fin-console-${VERSION}`;

/* 目录/文件排除规则。命中即整棵子树跳过。 */
const SKIP_DIRS = new Set(['data', 'data-demo', '.git', 'node_modules', 'dist', 'run', '.shots']);
const SKIP_FILES = new Set(['config.json', '.DS_Store']);
const skip = (name, isDir) =>
  (isDir && SKIP_DIRS.has(name)) ||
  (!isDir && (SKIP_FILES.has(name) || name.endsWith('.log') || name.startsWith('.tmp-')));

/* ---------------- 先重新构建，别发过期产物 ---------------- */
console.log('[pack] 重新构建前端…');
const build = spawnSync(process.execPath, ['scripts/build-frontend.mjs'], { cwd: ROOT, stdio: 'inherit' });
if (build.status !== 0) {
  console.error('[pack] 构建失败，已中止打包。');
  process.exit(1);
}

/* ---------------- 收集文件 ---------------- */
function collect(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip(entry.name, entry.isDirectory())) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}
const files = collect(ROOT).sort();
const total = files.reduce((n, f) => n + statSync(f).size, 0);
console.log(`[pack] 收集 ${files.length} 个文件，${(total / 1024).toFixed(1)} KB`);

/* ---------------- tar.gz ---------------- */
/*
 * 自己写 tar 而不是调系统 tar，是为了两件事：
 *   1) 归档里的路径统一为 fin-console-<版本>/...，解开就是一个干净的目录；
 *   2) 时间戳、uid/gid、权限全部固定，同样的源码打出字节一致的包，方便校验。
 * 脚本类文件给 0755，其余 0644——不这么做的话 Windows 上取出来再传到 Linux
 * 会丢掉可执行位，install-linux.sh 直接跑不起来。
 */
function tarHeader({ name, size, mode, type = '0' }) {
  const buf = Buffer.alloc(512);
  /*
   * 两个写入助手，区别很重要：
   *   raw  按字段宽度原样写入，不补 NUL——校验和占位的 8 个空格必须是整整 8 个，
   *        少一个字节 tar 就会判定「校验和不符」，整个包读不出来。
   *   str  写 NUL 结尾的字符串（路径、magic、用户名这类）。
   */
  const raw = (text, off, len) => buf.write(String(text).padEnd(len, '\0').slice(0, len), off, len, 'utf8');
  const str = (text, off, len) => raw(String(text).slice(0, len - 1) + '\0', off, len);
  // 八进制数值字段：宽度 len 的字段写 len-1 位数字加一个 NUL
  const oct = (num, off, len) => raw(num.toString(8).padStart(len - 1, '0') + '\0', off, len);

  // 路径超过 100 字节要用 prefix 字段（ustar）。中文路径按字节算，很容易超。
  const nameBuf = Buffer.from(name, 'utf8');
  if (nameBuf.length <= 100) {
    raw(name, 0, 100);
  } else {
    const cut = name.lastIndexOf('/', 154);
    if (cut < 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) {
      throw new Error(`路径过长，tar 无法表示：${name}`);
    }
    raw(name.slice(cut + 1), 0, 100);
    raw(name.slice(0, cut), 345, 155);
  }
  oct(mode, 100, 8);
  oct(0, 108, 8);          // uid：固定 0，不带打包者身份
  oct(0, 116, 8);          // gid
  oct(size, 124, 12);
  oct(0, 136, 12);         // mtime：固定，保证同样源码打出字节一致的包
  raw('        ', 148, 8); // checksum 占位：必须是 8 个空格
  raw(type, 156, 1);
  raw('ustar\0', 257, 6);
  raw('00', 263, 2);
  str('root', 265, 32);
  str('root', 297, 32);

  // 校验和 = 全部 512 字节之和（占位为空格时计算），写成 6 位八进制 + NUL + 空格
  let sum = 0;
  for (const b of buf) sum += b;
  raw(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return buf;
}

const EXEC = /\.(sh|mjs)$/;
const tarParts = [];
tarParts.push(tarHeader({ name: `${NAME}/`, size: 0, mode: 0o755, type: '5' }));
for (const f of files) {
  const rel = relative(ROOT, f).split(sep).join('/');
  const data = readFileSync(f);
  const mode = EXEC.test(rel) ? 0o755 : 0o644;
  tarParts.push(tarHeader({ name: `${NAME}/${rel}`, size: data.length, mode }));
  tarParts.push(data);
  const pad = (512 - (data.length % 512)) % 512;
  if (pad) tarParts.push(Buffer.alloc(pad));
}
tarParts.push(Buffer.alloc(1024)); // 结束标记：两个空块
const tarBuf = Buffer.concat(tarParts);
const tgz = gzipSync(tarBuf, { level: 9 });

/* ---------------- zip ---------------- */
function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const body = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const flags = 0x0800; // 文件名按 UTF-8 解释，中文路径才不会乱码
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x2100, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x2100, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, end]);
}
const zipBuf = zip(
  files.map((f) => ({
    name: `${NAME}/${relative(ROOT, f).split(sep).join('/')}`,
    data: readFileSync(f),
  })),
);

/* ---------------- 落盘 ---------------- */
if (existsSync(DIST)) rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

const outputs = [
  [`${NAME}.tar.gz`, tgz],
  [`${NAME}.zip`, zipBuf],
];
const lines = [];
for (const [name, buf] of outputs) {
  writeFileSync(join(DIST, name), buf);
  const sha = createHash('sha256').update(buf).digest('hex');
  lines.push(`${sha}  ${name}`);
  console.log(`[pack] ${name.padEnd(34)} ${(buf.length / 1024).toFixed(1)} KB`);
}
// 校验和文件：拷来拷去之后可以确认包没坏、也没被换掉
writeFileSync(join(DIST, 'SHA256SUMS.txt'), lines.join('\n') + '\n');
console.log(`[pack] SHA256SUMS.txt`);
console.log(`[pack] 完成，输出目录：${DIST}`);
