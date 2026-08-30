#!/usr/bin/env node
/**
 * 全量测试编排：浏览器环境缺失不是用例通过，浏览器脚本以 code 3 表示跳过，
 * 这里保留该状态的可见性，同时不把环境能力不足误报为产品测试失败。
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const commands = [
  ['构建前端', 'scripts/build-frontend.mjs'],
  ['检查 ES 模块图', 'scripts/check-esm.mjs'],
  ['校验构建产物', 'scripts/verify-build.mjs'],
  // 前端纯逻辑用例不依赖浏览器，必须无条件跑：browser-test 在服务器和 CI 上通常直接跳过，
  // 只靠它的话前端逻辑等于没有自动化守护，而这次改动的要点大半在前端。
  ['检查前端核心逻辑', 'scripts/frontend-logic-test.mjs'],
  ['运行 smoke 测试', 'scripts/smoke-test.mjs'],
  ['运行浏览器测试', 'scripts/browser-test.mjs'],
];

for (const [label, script] of commands) {
  const result = spawnSync(process.execPath, [script], { cwd: ROOT, stdio: 'inherit', env: process.env });
  if (result.error) {
    console.error(`[test:all] ${label}无法启动：${result.error.message}`);
    process.exit(1);
  }
  if (result.status === 3 && script === 'scripts/browser-test.mjs') {
    console.log('[test:all] 浏览器测试已跳过：当前环境不具备浏览器测试条件。');
    continue;
  }
  if (result.status !== 0) {
    console.error(`[test:all] ${label}失败（退出码 ${result.status ?? '未知'}）。`);
    process.exit(result.status || 1);
  }
}

console.log('[test:all] 全部可执行测试通过。');
