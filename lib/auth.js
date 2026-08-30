/**
 * 账号、口令与会话。
 * 口令用 Node 内置 crypto.scryptSync 加盐哈希，不落明文；
 * 会话 token 为 32 字节随机值，仅通过 HttpOnly + SameSite=Strict Cookie 传递。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { nowIso, stmt } from './db.js';

export const ROLES = Object.freeze({
  admin: { label: '管理员', canWrite: true, canClose: true, canAdmin: true },
  accountant: { label: '记账员', canWrite: true, canClose: true, canAdmin: false },
  viewer: { label: '只读', canWrite: false, canClose: false, canAdmin: false },
});

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 128 * SCRYPT.N * SCRYPT.r * 2,
  }).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(String(expectedHash || ''), 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function passwordProblem(password) {
  const p = String(password || '');
  if (p.length < 8) return '口令至少 8 位';
  if (p.length > 200) return '口令过长';
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) return '口令需同时包含字母和数字';
  return null;
}

export function findUserByName(username) {
  return stmt('SELECT * FROM users WHERE username = ?').get(String(username || '')) || null;
}

export function findUserById(id) {
  return stmt('SELECT * FROM users WHERE id = ?').get(id) || null;
}

export function listUsers() {
  return stmt(
    `SELECT id, username, display_name, role, disabled, must_change, created_at, last_login
     FROM users ORDER BY id`,
  ).all();
}

export function createUser({ username, password, displayName = '', role = 'accountant', mustChange = 0 }) {
  const name = String(username || '').trim();
  if (!/^[A-Za-z0-9_.@-]{2,40}$/.test(name)) throw new Error('用户名只能是 2-40 位字母、数字或 _ . @ -');
  if (!ROLES[role]) throw new Error('角色无效');
  const bad = passwordProblem(password);
  if (bad) throw new Error(bad);
  const { salt, hash } = hashPassword(password);
  stmt(
    `INSERT INTO users (username, display_name, role, pwd_hash, pwd_salt, must_change, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(name, String(displayName || name), role, hash, salt, mustChange ? 1 : 0, nowIso());
  return findUserByName(name);
}

export function setPassword(userId, password, { mustChange = 0 } = {}) {
  const bad = passwordProblem(password);
  if (bad) throw new Error(bad);
  const { salt, hash } = hashPassword(password);
  stmt('UPDATE users SET pwd_hash = ?, pwd_salt = ?, must_change = ? WHERE id = ?').run(
    hash,
    salt,
    mustChange ? 1 : 0,
    userId,
  );
}

/** 仍然启用、且具备管理权限的账号数量 */
export function activeAdminCount() {
  const roles = Object.keys(ROLES).filter((r) => ROLES[r].canAdmin);
  if (!roles.length) return 0;
  const marks = roles.map(() => '?').join(',');
  return (
    stmt(`SELECT COUNT(*) AS n FROM users WHERE disabled = 0 AND role IN (${marks})`).get(...roles)?.n || 0
  );
}

/**
 * 修改账号属性。
 *
 * 会拦住「把最后一个管理员降级或停用」：管理权限一旦归零，就再也没有账号能
 * 改回来（/api/users 全部要 canAdmin），只能停服跑 CLI——而 reset-password
 * 脚本只能改口令、不能改角色，等于系统永久失去管理能力。
 * 这里在写入前算一次剩余管理员数，为 0 就直接拒绝。
 */
export function updateUser(userId, { displayName, role, disabled }) {
  const u = findUserById(userId);
  if (!u) throw new Error('用户不存在');
  const next = {
    display_name: displayName === undefined ? u.display_name : String(displayName || ''),
    role: role === undefined ? u.role : String(role),
    disabled: disabled === undefined ? u.disabled : disabled ? 1 : 0,
  };
  if (!ROLES[next.role]) throw new Error('角色无效');

  const wasAdmin = !u.disabled && can(u.role, 'canAdmin');
  const staysAdmin = !next.disabled && can(next.role, 'canAdmin');
  if (wasAdmin && !staysAdmin && activeAdminCount() <= 1) {
    throw new Error('这是最后一个可用的管理员账号，不能降级或停用；请先另设一名管理员');
  }

  stmt('UPDATE users SET display_name = ?, role = ?, disabled = ? WHERE id = ?').run(
    next.display_name,
    next.role,
    next.disabled,
    userId,
  );
  if (next.disabled) revokeUserSessions(userId);
  return findUserById(userId);
}

/* ---------------- 会话 ---------------- */

export const SESSION_COOKIE = 'fin_sid';

export function createSession(userId, { ip = '', agent = '' } = {}) {
  const token = randomBytes(32).toString('base64url');
  const created = new Date();
  const expires = new Date(created.getTime() + config.sessionHours * 3600 * 1000);
  stmt(
    `INSERT INTO sessions (token, user_id, created_at, expires_at, ip, agent)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(token, userId, created.toISOString(), expires.toISOString(), String(ip).slice(0, 64), String(agent).slice(0, 300));
  stmt('UPDATE users SET last_login = ? WHERE id = ?').run(created.toISOString(), userId);
  return { token, expiresAt: expires };
}

export function readSession(token) {
  if (!token) return null;
  const row = stmt(
    `SELECT s.token, s.expires_at, u.id, u.username, u.display_name, u.role, u.disabled, u.must_change
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
  ).get(String(token));
  if (!row) return null;
  if (row.disabled) {
    revokeSession(token);
    return null;
  }
  if (Date.parse(row.expires_at) <= Date.now()) {
    revokeSession(token);
    return null;
  }
  return {
    token: row.token,
    expiresAt: row.expires_at,
    user: {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      mustChange: !!row.must_change,
    },
  };
}

/** 滑动续期：剩余不足一半有效期时自动延长，长时间连续作业不会被中途踢出 */
export function touchSession(token) {
  const row = stmt('SELECT expires_at FROM sessions WHERE token = ?').get(String(token));
  if (!row) return null;
  const total = config.sessionHours * 3600 * 1000;
  const left = Date.parse(row.expires_at) - Date.now();
  if (left > total / 2) return null;
  const next = new Date(Date.now() + total);
  stmt('UPDATE sessions SET expires_at = ? WHERE token = ?').run(next.toISOString(), String(token));
  return next;
}

export function revokeSession(token) {
  stmt('DELETE FROM sessions WHERE token = ?').run(String(token || ''));
}

export function revokeUserSessions(userId) {
  stmt('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function purgeExpiredSessions() {
  stmt('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso());
}

/* ---------------- 登录限流 ---------------- */

export function recordLoginAttempt(subject, ok) {
  stmt('INSERT INTO login_attempts (at, subject, ok) VALUES (?, ?, ?)').run(nowIso(), String(subject), ok ? 1 : 0);
}

/**
 * 该维度在时间窗内的失败次数是否已达上限。
 * limit 可覆盖：调用方按「用户名@IP / 纯 IP / 纯用户名」三个维度分别用不同阈值，
 * 详见 lib/routes.js 的 /api/login。
 */
export function loginBlocked(subject, limit = config.loginMaxAttempts) {
  const since = new Date(Date.now() - config.loginWindowMinutes * 60 * 1000).toISOString();
  const row = stmt('SELECT COUNT(*) AS n FROM login_attempts WHERE subject = ? AND ok = 0 AND at > ?').get(
    String(subject),
    since,
  );
  return (row?.n || 0) >= Math.max(1, Number(limit) || config.loginMaxAttempts);
}

export function clearLoginAttempts(subject) {
  stmt('DELETE FROM login_attempts WHERE subject = ?').run(String(subject));
}

export function purgeOldLoginAttempts() {
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  stmt('DELETE FROM login_attempts WHERE at < ?').run(since);
}

export function can(role, capability) {
  return !!ROLES[role]?.[capability];
}
