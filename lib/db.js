/**
 * SQLite 存储层。使用 Node 内置 node:sqlite（Node 22.5+），零外部依赖。
 * 表结构说明：
 *   users        账号与角色
 *   sessions     登录会话（HttpOnly Cookie 的服务端凭据）
 *   records      全部模块的台账记录（module 列存模块 key），业务字段整体存 props(JSON)，
 *                另把 单位/期间 提取为独立列以便过滤与索引
 *   closures     模块 × 期间 的结账锁（全局共享，替代原来的 localStorage）
 *   settings     共享设置：当前会计期间、打印列配置等
 *   audit_log    写操作审计
 *   org_units    单位受控清单（主数据）
 *   org_projects 项目受控清单（主数据，隶属于某个单位）
 *   user_prefs   个人偏好（如「我想看哪个月」），与全局 settings 分开
 *
 * 主数据为什么必须受控：专项费用的计提链条按「单位|项目名称」匹配上期累计。
 * 名称错一个字，链条就会断开，上期基数丢失，本期产值被当成全部累计额，
 * 计提金额直接翻倍而系统不会报任何错。所以名称只能从清单里选，不能手打。
 */
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config, paths } from './config.js';

mkdirSync(config.dataDir, { recursive: true });
mkdirSync(paths.backupDir, { recursive: true });

export const db = new DatabaseSync(paths.dbFile);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  username     TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  role         TEXT NOT NULL DEFAULT 'accountant',
  pwd_hash     TEXT NOT NULL,
  pwd_salt     TEXT NOT NULL,
  must_change  INTEGER NOT NULL DEFAULT 0,
  disabled     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  last_login   TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip         TEXT NOT NULL DEFAULT '',
  agent      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS records (
  id         TEXT PRIMARY KEY,
  module     TEXT NOT NULL,
  unit       TEXT NOT NULL DEFAULT '',
  period     TEXT NOT NULL DEFAULT '',
  props      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT '',
  rev        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_records_module ON records(module);
CREATE INDEX IF NOT EXISTS idx_records_module_period ON records(module, period);

CREATE TABLE IF NOT EXISTS closures (
  module    TEXT NOT NULL,
  period    TEXT NOT NULL,
  closed_at TEXT NOT NULL,
  closed_by TEXT NOT NULL DEFAULT '',
  note      TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (module, period)
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS audit_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       TEXT NOT NULL,
  actor    TEXT NOT NULL DEFAULT '',
  ip       TEXT NOT NULL DEFAULT '',
  action   TEXT NOT NULL,
  module   TEXT NOT NULL DEFAULT '',
  rec_id   TEXT NOT NULL DEFAULT '',
  detail   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_module ON audit_log(module, at DESC);
-- 追单条记录的修改历史（谁在什么时候把金额从多少改成了多少）
CREATE INDEX IF NOT EXISTS idx_audit_rec ON audit_log(rec_id, id);

CREATE TABLE IF NOT EXISTS login_attempts (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  subject TEXT NOT NULL,
  ok      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_login_subject ON login_attempts(subject, at DESC);

CREATE TABLE IF NOT EXISTS org_units (
  name       TEXT PRIMARY KEY,
  short_name TEXT NOT NULL DEFAULT '',
  active     INTEGER NOT NULL DEFAULT 1,
  sort       INTEGER NOT NULL DEFAULT 0,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS org_projects (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  unit       TEXT NOT NULL,
  name       TEXT NOT NULL,
  rate       REAL,
  active     INTEGER NOT NULL DEFAULT 1,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  UNIQUE (unit, name)
);
CREATE INDEX IF NOT EXISTS idx_projects_unit ON org_projects(unit, active);

-- 个人偏好：每账号一份，与全局 settings 分开。
-- 目前只放「视图期间」——我想看哪个月是个人选择，不该改到别人的界面；
-- 而结账锁与结转依赖的「账套期间」仍然在 settings 里全局唯一。
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
`);

/** 简单的 statement 缓存，避免每次调用都重新 prepare */
const cache = new Map();
export function stmt(sql) {
  let s = cache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    cache.set(sql, s);
  }
  return s;
}

export function nowIso() {
  return new Date().toISOString();
}

/** 在一个事务里执行 fn；抛错则整体回滚 */
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 回滚失败时保留原始错误 */
    }
    throw err;
  }
}

export function closeDb() {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    /* 忽略 checkpoint 失败 */
  }
  db.close();
}
