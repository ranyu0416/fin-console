/**
 * 备份：用 SQLite 官方 backup API 做在线热备（不阻塞写入、不会拷到半个事务），
 * 并按保留份数清理旧文件。手工执行：npm run backup
 */
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { backup } from 'node:sqlite';
import { config, paths } from './config.js';
import { db } from './db.js';

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export async function runBackup() {
  const file = join(paths.backupDir, `fin-${stamp()}.db`);
  await backup(db, file);
  pruneBackups();
  return file;
}

export function pruneBackups() {
  const keep = Math.max(1, config.backupKeep);
  const files = readdirSync(paths.backupDir)
    .filter((f) => /^fin-\d{8}-\d{6}\.db$/.test(f))
    .map((f) => ({ f, t: statSync(join(paths.backupDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const extra of files.slice(keep)) {
    try {
      unlinkSync(join(paths.backupDir, extra.f));
    } catch (err) {
      console.error(`[backup] 删除旧备份 ${extra.f} 失败：${err.message}`);
    }
  }
  return files.length;
}

export function listBackups() {
  return readdirSync(paths.backupDir)
    .filter((f) => /^fin-\d{8}-\d{6}\.db$/.test(f))
    .map((f) => {
      const s = statSync(join(paths.backupDir, f));
      return { file: f, size: s.size, at: new Date(s.mtimeMs).toISOString() };
    })
    .sort((a, b) => (a.at < b.at ? 1 : -1));
}

/** 启动自动备份定时器，返回停止函数 */
export function startBackupSchedule() {
  const hours = config.backupIntervalHours;
  if (!hours || hours <= 0) {
    console.log('[backup] 自动备份已关闭（FIN_BACKUP_INTERVAL_HOURS=0）');
    return () => {};
  }
  const tick = async () => {
    try {
      const file = await runBackup();
      console.log(`[backup] 已生成备份 ${file}`);
    } catch (err) {
      console.error(`[backup] 备份失败：${err.message}`);
    }
  };
  // 启动后 1 分钟先做一次，避免服务器长期不重启时一直没有基线备份
  const first = setTimeout(tick, 60 * 1000);
  const timer = setInterval(tick, hours * 3600 * 1000);
  timer.unref?.();
  first.unref?.();
  console.log(`[backup] 自动备份已开启：每 ${hours} 小时一次，保留 ${config.backupKeep} 份`);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
