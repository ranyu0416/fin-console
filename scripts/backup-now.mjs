#!/usr/bin/env node
/**
 * 手工触发一次热备份（服务在跑也能安全执行）。
 *   node scripts/backup-now.mjs
 * 适合挂进 cron / 计划任务，与服务内置的定时备份可并存。
 */
import { listBackups, runBackup } from '../lib/backup.js';
import { closeDb } from '../lib/db.js';

try {
  const file = await runBackup();
  console.log(`已生成备份：${file}`);
  const list = listBackups();
  console.log(`当前保留 ${list.length} 份备份，最新：${list[0]?.file || '—'}`);
} catch (err) {
  console.error(`备份失败：${err.message}`);
  process.exit(1);
} finally {
  closeDb();
}
