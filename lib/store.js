/**
 * 台账数据访问层：记录 CRUD、结账锁、共享设置、审计。
 * 记录 id 用时间前缀 + 随机后缀，保证插入顺序可读且不冲突。
 */
import { randomBytes } from 'node:crypto';
import { nowIso, stmt, tx } from './db.js';
import { businessErrors } from './business.js';
import { normalizeName } from './names.js';
import { MODULE_KEYS, MODULES, normalizeProperties, periodOf, validMonth } from './schema.js';

function newId(moduleKey) {
  const t = Date.now().toString(36);
  return `${moduleKey}_${t}${randomBytes(4).toString('hex')}`;
}

function rowToRecord(row) {
  let props = {};
  try {
    props = JSON.parse(row.props);
  } catch {
    props = {};
  }
  return {
    ...props,
    _id: row.id,
    _module: row.module,
    _rev: row.rev,
    _createdAt: row.created_at,
    _createdBy: row.created_by,
    _updatedAt: row.updated_at,
    _updatedBy: row.updated_by,
  };
}

/** listRecords / countMatching 共用的 WHERE 构造，保证「数出来的」和「取出来的」是同一批 */
function recordFilter(mod, { period = '', unit = '' } = {}) {
  const where = ['module = ?'];
  const args = [mod.key];
  if (period) {
    where.push('period = ?');
    args.push(period);
  }
  if (unit) {
    where.push('unit = ?');
    args.push(unit);
  }
  return { clause: where.join(' AND '), args };
}

export function listRecords(mod, { period = '', unit = '', limit = 20000 } = {}) {
  const { clause, args } = recordFilter(mod, { period, unit });
  const lim = Math.max(1, Math.min(Number(limit) || 20000, 100000));
  const rows = stmt(
    `SELECT * FROM records WHERE ${clause}
     ORDER BY period ASC, created_at ASC LIMIT ?`,
  ).all(...args, lim);
  return rows.map(rowToRecord);
}

/**
 * 同一批过滤条件下的真实总数（不受 limit 影响）。
 *
 * 为什么必须有它：listRecords 按 (期间, 创建时间) 升序取前 N 条，
 * 被 limit 砍掉的是**最新**的记录。调用方只拿到 N 条时无法区分
 * 「一共就这么多」和「还有更多、而且丢的正是本期」——
 * 而 levy/union 的计提是链式的，少了最后一段仍然算得出一个自洽但错误的金额。
 * 所以「取多少条」和「一共多少条」必须分开告诉调用方。
 */
export function countMatching(mod, { period = '', unit = '' } = {}) {
  const { clause, args } = recordFilter(mod, { period, unit });
  return stmt(`SELECT COUNT(*) AS n FROM records WHERE ${clause}`).get(...args)?.n || 0;
}

export function getRecord(mod, id) {
  const row = stmt('SELECT * FROM records WHERE id = ? AND module = ?').get(String(id), mod.key);
  return row ? rowToRecord(row) : null;
}

export function countRecords(mod) {
  return stmt('SELECT COUNT(*) AS n FROM records WHERE module = ?').get(mod.key)?.n || 0;
}

export function createRecord(mod, properties, actor) {
  const { data, errors, unknown } = normalizeProperties(mod, properties, { partial: false });
  if (errors.length) throw new ValidationError(errors.join('；'));
  // 业务校验（非负金额、期初接续成对、开累单调、业务主键去重）：
  // 新增时全部字段都算「本次写入」，与录入表单同一套规则在服务端再兜一次
  const bErr = businessErrors(mod, data, { touched: new Set(Object.keys(data)) });
  if (bErr.length) throw new ValidationError(bErr.join('；'));
  const id = newId(mod.key);
  const at = nowIso();
  const period = periodOf(mod, data) || '';
  stmt(
    `INSERT INTO records (id, module, unit, period, props, created_at, created_by, updated_at, updated_by, rev)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  ).run(id, mod.key, String(data['单位'] || ''), period, JSON.stringify(data), at, actor, at, actor);
  return { record: getRecord(mod, id), unknown };
}

/**
 * 更新一条记录。
 *
 * expectedRev 是乐观锁：调用方把读到的 _rev 一起传回来，只有版本仍然一致才写入。
 * 没有这一层的后果是「静默覆盖」——两个人同时打开同一条记录，后点保存的人
 * 会把前一个人的修改整条盖掉，双方都看不到任何提示，审计里也只有两条各自
 * 看起来正常的 update。多人共享账套是这个系统的主要用途，这个缺口必须堵上。
 *
 * 传 undefined/null 表示调用方明确放弃版本校验（例如 CLI 脚本、数据迁移）。
 */
export function updateRecord(mod, id, properties, actor, { expectedRev = null } = {}) {
  const existing = getRecord(mod, id);
  if (!existing) throw new NotFoundError('记录不存在或已被其他人删除');
  if (expectedRev !== null && expectedRev !== undefined) {
    const want = Number(expectedRev);
    if (!Number.isFinite(want)) throw new ValidationError('rev 必须是数字');
    if (want !== Number(existing._rev)) {
      throw new ConflictError(
        `这条记录已被 ${existing._updatedBy || '其他人'} 修改过（你看到的是第 ${want} 版，` +
          `当前是第 ${existing._rev} 版）。请刷新后在最新数据上重新修改，避免覆盖对方的改动。`,
      );
    }
  }
  const { data, errors, unknown } = normalizeProperties(mod, properties, { partial: true });
  if (errors.length) throw new ValidationError(errors.join('；'));

  const merged = {};
  for (const f of mod.fields) {
    if (Object.prototype.hasOwnProperty.call(data, f.name)) merged[f.name] = data[f.name];
    else if (Object.prototype.hasOwnProperty.call(existing, f.name)) merged[f.name] = existing[f.name];
  }
  // 业务校验只针对本次提交的字段：存量数据里的历史错误不该把「改备注」这类
  // 无关修改一并锁死；但只要碰了金额/期间/身份字段，合并后的结果就必须合规
  const bErr = businessErrors(mod, merged, { touched: new Set(Object.keys(data)), excludeId: String(id) });
  if (bErr.length) throw new ValidationError(bErr.join('；'));
  const at = nowIso();
  // rev 也进 WHERE：即使两个请求挤在同一毫秒通过了上面的检查，数据库这一层仍然只让一个人赢
  const info = stmt(
    `UPDATE records SET unit = ?, period = ?, props = ?, updated_at = ?, updated_by = ?, rev = rev + 1
     WHERE id = ? AND module = ? AND rev = ?`,
  ).run(
    String(merged['单位'] || ''),
    periodOf(mod, merged) || '',
    JSON.stringify(merged),
    at,
    actor,
    String(id),
    mod.key,
    Number(existing._rev),
  );
  if (!info.changes) {
    const now = getRecord(mod, id);
    if (!now) throw new NotFoundError('记录已被其他人删除');
    throw new ConflictError('这条记录刚被其他人修改，请刷新后重试。');
  }
  return { record: getRecord(mod, id), before: existing, unknown };
}

export function deleteRecord(mod, id) {
  const existing = getRecord(mod, id);
  if (!existing) throw new NotFoundError('记录不存在或已被其他人删除');
  stmt('DELETE FROM records WHERE id = ? AND module = ?').run(String(id), mod.key);
  return existing;
}

export function deleteModuleRecords(mod, { period = '' } = {}) {
  if (period) {
    const n = stmt('SELECT COUNT(*) AS n FROM records WHERE module = ? AND period = ?').get(mod.key, period)?.n || 0;
    stmt('DELETE FROM records WHERE module = ? AND period = ?').run(mod.key, period);
    return n;
  }
  const n = countRecords(mod);
  stmt('DELETE FROM records WHERE module = ?').run(mod.key);
  return n;
}

/**
 * 批量导入：整模块替换或追加。用于粘贴导入与从旧的浏览器 localStorage 迁移。
 * validateRow 可选，用于叠加受控清单等业务校验（返回错误文本数组）。
 * 返回 { inserted, skipped, errors }
 */
export function importRecords(mod, rows, actor, { replace = false, validateRow = null, businessCheck = true } = {}) {
  if (!Array.isArray(rows)) throw new ValidationError('rows 必须是数组');
  return tx(() => {
    if (replace) stmt('DELETE FROM records WHERE module = ?').run(mod.key);
    let inserted = 0;
    const errors = [];
    rows.forEach((raw, i) => {
      const { data, errors: rowErrors } = normalizeProperties(mod, raw, { partial: false });
      if (rowErrors.length) {
        errors.push(`第 ${i + 1} 行：${rowErrors.join('；')}`);
        return;
      }
      if (validateRow) {
        const extra = validateRow(data, i);
        if (extra && extra.length) {
          errors.push(`第 ${i + 1} 行：${extra.join('；')}`);
          return;
        }
      }
      // 逐行业务校验：校验发生在同一事务内、且逐行先插先验，
      // 所以批内重复与「后面一行比前面一行开累还小」都会被前面的行拦住
      if (businessCheck) {
        const bErr = businessErrors(mod, data, { touched: new Set(Object.keys(data)) });
        if (bErr.length) {
          errors.push(`第 ${i + 1} 行：${bErr.join('；')}`);
          return;
        }
      }
      const at = nowIso();
      stmt(
        `INSERT INTO records (id, module, unit, period, props, created_at, created_by, updated_at, updated_by, rev)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(newId(mod.key), mod.key, String(data['单位'] || ''), periodOf(mod, data) || '', JSON.stringify(data), at, actor, at, actor);
      inserted += 1;
    });
    return { inserted, skipped: rows.length - inserted, errors };
  });
}

/* ---------------- 结账锁（模块 × 期间，全局共享） ---------------- */

export function assertPeriod(period) {
  const s = String(period || '');
  if (!/^\d{4}-\d{2}$/.test(s)) throw new ValidationError('期间格式必须是 YYYY-MM');
  // 只校验格式会放过 2026-13 / 2026-00，它们能一路写进 settings 成为「当前期间」
  if (!validMonth(s)) throw new ValidationError(`期间「${s}」不是真实存在的年月`);
  return s;
}

export function listClosures() {
  return stmt('SELECT module, period, closed_at, closed_by, note FROM closures ORDER BY period DESC, module').all().map((c) => ({
    key: `${c.module}|${c.period}`,
    module: c.module,
    period: c.period,
    status: '已结账',
    closedAt: c.closed_at,
    closedBy: c.closed_by,
    note: c.note,
  }));
}

export function isClosed(moduleKey, period) {
  if (!moduleKey || !period) return false;
  return !!stmt('SELECT 1 FROM closures WHERE module = ? AND period = ?').get(String(moduleKey), String(period));
}

export function setClosed(moduleKey, period, on, actor, note = '') {
  assertPeriod(period);
  if (on) {
    stmt(
      `INSERT INTO closures (module, period, closed_at, closed_by, note) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(module, period) DO UPDATE SET closed_at = excluded.closed_at, closed_by = excluded.closed_by, note = excluded.note`,
    ).run(String(moduleKey), String(period), nowIso(), actor, String(note || ''));
  } else {
    stmt('DELETE FROM closures WHERE module = ? AND period = ?').run(String(moduleKey), String(period));
  }
  return listClosures();
}

/* ---------------- 共享设置 ---------------- */

export const SETTING_KEYS = Object.freeze({
  /**
   * 全局「账套期间」。整个账套只有一个，代表这套账目前推进到哪个月。
   * 它决定两件事，都必须全局一致，不能各人一套：
   *   1. 无期间字段模块（设施/固定资产/减值准备）的记录归属哪一期，
   *      从而决定「结账 facility 2026-03」锁住哪些记录；
   *   2. 本月结转的默认目标期间。
   * 因此只有能结账的角色（管理员/记账员）可以推进它。
   */
  workPeriod: 'work_period',
  orgName: 'org_name',
  printProfiles: 'print_profiles',
  // 是否强制「单位/项目」只能取自受控清单。默认开启：这是防止计提链条断裂的关键。
  masterDataStrict: 'master_data_strict',
});

/** 个人偏好的键名。这些值每个账号一份，互不影响。 */
export const PREF_KEYS = Object.freeze({
  /**
   * 个人「视图期间」：我现在想看哪个月。
   * 只影响这个账号自己的筛选默认值与新增记录时预填的期间，不影响别人，
   * 也不影响结账锁——锁永远按全局账套期间判定。
   */
  viewPeriod: 'view_period',
  /**
   * 个人「隐藏的模块」：模块显隐自选。只影响这个账号自己的导航页签，
   * 不影响数据，也不影响其他人。
   */
  hiddenModules: 'hidden_modules',
});

export function getSetting(key, fallback = null) {
  const row = stmt('SELECT value FROM settings WHERE key = ?').get(String(key));
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

export function setSetting(key, value, actor) {
  stmt(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run(String(key), JSON.stringify(value === undefined ? null : value), nowIso(), actor);
  return value;
}

/** 本机当前年月，作为一切期间的最终兜底 */
function thisMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * 全局账套期间。结账锁与结转的权威基准，全账套唯一。
 * 名字保留 currentWorkPeriod 不改，因为它已经被 routes/carry 大量引用，
 * 改名只会制造无意义的 diff；语义在 SETTING_KEYS.workPeriod 上有完整说明。
 */
export function currentWorkPeriod() {
  const stored = getSetting(SETTING_KEYS.workPeriod, null);
  if (validMonth(stored)) return String(stored);
  return thisMonth();
}

/* ---------------- 个人偏好（每账号一份） ---------------- */

export function getPref(userId, key, fallback = null) {
  const row = stmt('SELECT value FROM user_prefs WHERE user_id = ? AND key = ?').get(Number(userId), String(key));
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

export function setPref(userId, key, value) {
  stmt(
    `INSERT INTO user_prefs (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(Number(userId), String(key), JSON.stringify(value === undefined ? null : value), nowIso());
  return value;
}

/**
 * 某个账号的视图期间。
 * 没设过就跟随全局账套期间——新用户登录看到的是「这套账现在在做哪个月」，
 * 这是最符合直觉的默认值；一旦他自己切过月份，就以他自己的选择为准。
 */
export function viewPeriodOf(userId) {
  const own = getPref(userId, PREF_KEYS.viewPeriod, null);
  if (validMonth(own)) return String(own);
  return currentWorkPeriod();
}

export function setViewPeriod(userId, period) {
  const p = assertPeriod(period);
  setPref(userId, PREF_KEYS.viewPeriod, p);
  return p;
}

/**
 * 受控清单是否强制。默认 true。
 * 关掉只应作为迁移期的临时手段——关掉之后名称错字不会再被拦住。
 */
export function masterDataStrict() {
  const v = getSetting(SETTING_KEYS.masterDataStrict, null);
  return v === null || v === undefined ? true : !!v;
}

/* ---------------- 审计 ---------------- */

export function audit({ actor = '', ip = '', action, module = '', recId = '', detail = '' }) {
  stmt('INSERT INTO audit_log (at, actor, ip, action, module, rec_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    nowIso(),
    String(actor),
    String(ip),
    String(action),
    String(module),
    String(recId),
    typeof detail === 'string' ? detail.slice(0, 4000) : JSON.stringify(detail).slice(0, 4000),
  );
}

/**
 * 审计日志查询。
 *
 * recId 是「这一条记录改过几次、谁改的、从多少改成多少」——对账时最常问的问题。
 * 原来只能按模块筛，想追一条金额的修改历史，得在整个模块的日志里翻页找。
 * rec_id 本来就存着，只是没有入口。
 */
export function listAudit({ module = '', recId = '', limit = 200, offset = 0 } = {}) {
  const lim = Math.max(1, Math.min(Number(limit) || 200, 1000));
  const off = Math.max(0, Number(offset) || 0);
  const where = [];
  const args = [];
  if (module) {
    where.push('module = ?');
    args.push(String(module));
  }
  if (recId) {
    where.push('rec_id = ?');
    args.push(String(recId));
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  /* 单条记录的历史按时间正序更好读（从建立到最近一次修改），列表仍然倒序 */
  const order = recId ? 'id ASC' : 'id DESC';
  return stmt(`SELECT * FROM audit_log ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, lim, off);
}

export function purgeAudit(keepDays = 730) {
  const since = new Date(Date.now() - keepDays * 24 * 3600 * 1000).toISOString();
  stmt('DELETE FROM audit_log WHERE at < ?').run(since);
}

/**
 * 全量导出（管理员备份用）。
 *
 * 必须包含 org_units / org_projects：受控清单是计提链条的基准，
 * 少了它们这份 JSON 就不足以重建账套——恢复出来的记录里全是「不在清单里」的名称。
 * 版本号从 1 提到 2 以示区分。
 */
export function exportAll() {
  const modules = {};
  for (const key of MODULE_KEYS) {
    modules[key] = stmt('SELECT * FROM records WHERE module = ? ORDER BY created_at').all(key).map(rowToRecord);
  }
  return {
    exportedAt: nowIso(),
    version: 2,
    workPeriod: currentWorkPeriod(),
    closures: listClosures(),
    settings: {
      orgName: getSetting(SETTING_KEYS.orgName, ''),
      printProfiles: getSetting(SETTING_KEYS.printProfiles, {}),
      masterDataStrict: masterDataStrict(),
    },
    masterData: {
      units: stmt('SELECT name, short_name, active, sort, note, created_at, created_by FROM org_units ORDER BY sort, name').all(),
      projects: stmt(
        'SELECT unit, name, rate, active, note, created_at, created_by FROM org_projects ORDER BY unit, name',
      ).all(),
    },
    modules,
  };
}

/**
 * 从 exportAll() 的产物恢复整套账。
 *
 * 为什么需要它：项目本来只有导出，没有任何导入入口。也就是说那份 JSON 备份
 * 实际上是「只能看不能用」的——真出事时唯一的恢复路径是手工拼 SQL。
 * 备份的价值等于恢复能力，只导不进的备份等于没有备份。
 *
 * 语义：整库替换，不是合并。合并需要逐条判断「同一笔业务」的身份，
 * 而这套数据的天然主键是「单位|项目|期间」这类业务组合键，一旦有歧义
 * 就会静默产生重复计提——宁可要求先备份再整体覆盖，也不做半自动合并。
 *
 * dryRun 时只解析和校验，不落任何数据，用于让管理员先看清将要覆盖什么。
 */
export function importAll(payload, actor, { dryRun = false } = {}) {
  if (!payload || typeof payload !== 'object') throw new ValidationError('备份内容必须是 JSON 对象');
  const version = Number(payload.version) || 1;
  if (version > 2) throw new ValidationError(`备份格式版本 ${version} 高于当前程序支持的 2，请升级程序后再恢复`);
  const modules = payload.modules;
  if (!modules || typeof modules !== 'object') throw new ValidationError('备份缺少 modules 字段，不是本系统导出的文件');

  // 先全量校验再决定是否写入：不接受「导到一半失败」的中间状态
  const plan = [];
  const errors = [];
  for (const key of MODULE_KEYS) {
    const rows = Array.isArray(modules[key]) ? modules[key] : [];
    const mod = MODULES[key];
    const good = [];
    rows.forEach((raw, i) => {
      const { data, errors: rowErrors } = normalizeProperties(mod, raw, { partial: true });
      if (rowErrors.length) {
        errors.push(`${mod.name} 第 ${i + 1} 条：${rowErrors.join('；')}`);
        return;
      }
      good.push({ data, meta: raw });
    });
    plan.push({ key, mod, rows: good, skipped: rows.length - good.length });
  }
  if (errors.length > 20) errors.length = 20;   // 报表要能看，不要糊一屏

  const summary = {
    version,
    exportedAt: payload.exportedAt || null,
    willReplace: {},
    incoming: {},
    units: Array.isArray(payload.masterData?.units) ? payload.masterData.units.length : 0,
    projects: Array.isArray(payload.masterData?.projects) ? payload.masterData.projects.length : 0,
    closures: Array.isArray(payload.closures) ? payload.closures.length : 0,
    errors,
  };
  for (const p of plan) {
    summary.willReplace[p.key] = countRecords(p.mod);
    summary.incoming[p.key] = p.rows.length;
  }
  if (dryRun) return { ok: true, dryRun: true, ...summary };
  if (errors.length) throw new ValidationError(`备份内容有 ${errors.length} 处无法解析，已中止：${errors[0]}`);

  return tx(() => {
    for (const p of plan) {
      stmt('DELETE FROM records WHERE module = ?').run(p.key);
      for (const item of p.rows) {
        // 保留原始的创建/修改痕迹：审计意义上「谁在什么时候录的」不该因为恢复而丢失
        const createdAt = String(item.meta._createdAt || nowIso());
        const createdBy = String(item.meta._createdBy || actor);
        const updatedAt = String(item.meta._updatedAt || createdAt);
        const updatedBy = String(item.meta._updatedBy || createdBy);
        const rev = Number(item.meta._rev) || 1;
        stmt(
          `INSERT INTO records (id, module, unit, period, props, created_at, created_by, updated_at, updated_by, rev)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          String(item.meta._id || newId(p.key)),
          p.key,
          String(item.data['单位'] || ''),
          periodOf(p.mod, item.data) || '',
          JSON.stringify(item.data),
          createdAt,
          createdBy,
          updatedAt,
          updatedBy,
          rev,
        );
      }
    }

    // 受控清单：这是计提链条的匹配基准，必须跟记录一起恢复，否则恢复出来的
    // 记录全是「不在清单里」的名称，谁都改不动
    if (Array.isArray(payload.masterData?.units)) {
      stmt('DELETE FROM org_units').run();
      for (const u of payload.masterData.units) {
        const name = normalizeName(u?.name);
        if (!name) continue;
        stmt(
          `INSERT INTO org_units (name, short_name, active, sort, note, created_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(name) DO NOTHING`,
        ).run(
          name,
          String(u.short_name ?? u.shortName ?? ''),
          u.active === false ? 0 : 1,
          Number(u.sort) || 0,
          String(u.note || ''),
          String(u.created_at || u.createdAt || nowIso()),
          String(u.created_by || u.createdBy || actor),
        );
      }
    }
    if (Array.isArray(payload.masterData?.projects)) {
      stmt('DELETE FROM org_projects').run();
      for (const p2 of payload.masterData.projects) {
        const unit = normalizeName(p2?.unit);
        const name = normalizeName(p2?.name);
        if (!unit || !name) continue;
        stmt(
          `INSERT INTO org_projects (unit, name, rate, active, note, created_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(unit, name) DO NOTHING`,
        ).run(
          unit,
          name,
          p2.rate === null || p2.rate === undefined || p2.rate === '' ? null : Number(p2.rate),
          p2.active === false ? 0 : 1,
          String(p2.note || ''),
          String(p2.created_at || p2.createdAt || nowIso()),
          String(p2.created_by || p2.createdBy || actor),
        );
      }
    }

    // 结账锁：不恢复的话，已结账的期间会变回可写，等于把账重新打开
    if (Array.isArray(payload.closures)) {
      stmt('DELETE FROM closures').run();
      for (const c of payload.closures) {
        const modKey = String(c?.module || '');
        const period = String(c?.period || '');
        if (!MODULE_KEYS.includes(modKey) || !validMonth(period)) continue;
        stmt(
          `INSERT INTO closures (module, period, closed_at, closed_by, note) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(module, period) DO NOTHING`,
        ).run(modKey, period, String(c.closedAt || c.closed_at || nowIso()), String(c.closedBy || c.closed_by || actor), String(c.note || ''));
      }
    }

    if (validMonth(payload.workPeriod)) setSetting(SETTING_KEYS.workPeriod, String(payload.workPeriod), actor);
    if (payload.settings && typeof payload.settings === 'object') {
      if (payload.settings.orgName !== undefined) setSetting(SETTING_KEYS.orgName, String(payload.settings.orgName || ''), actor);
      if (payload.settings.printProfiles !== undefined) setSetting(SETTING_KEYS.printProfiles, payload.settings.printProfiles || {}, actor);
      if (payload.settings.masterDataStrict !== undefined) {
        setSetting(SETTING_KEYS.masterDataStrict, !!payload.settings.masterDataStrict, actor);
      }
    }

    return { ok: true, dryRun: false, ...summary };
  });
}

/**
 * 各模块的汇总数字，供总览页使用。
 *
 * 存在的理由是带宽：以前总览页调 /api/overview 把 6 个模块的完整记录全拉下来
 * （300 条数据就是 98.8 KB，且随数据量线性增长），而页面上只显示每个模块的
 * 计数与合计。这里在 SQL 层数完再返回，响应体固定几百字节。
 *
 * 只做与业务口径无关的通用统计（条数、期间分布、单位数）；各模块的计提金额
 * 口径复杂（要按启用日期、残值率、上期累计逐条推算），仍然留在前端算，
 * 但只在用户真正进入那个模块时才拉该模块的明细。
 */
export function moduleSummaries() {
  const out = {};
  for (const key of MODULE_KEYS) {
    const base = stmt(
      `SELECT COUNT(*) AS total,
              COUNT(DISTINCT CASE WHEN unit <> '' THEN unit END) AS units,
              MAX(updated_at) AS lastUpdated
       FROM records WHERE module = ?`,
    ).get(key) || {};
    const periods = stmt(
      `SELECT period, COUNT(*) AS n FROM records
       WHERE module = ? AND period <> '' GROUP BY period ORDER BY period DESC LIMIT 24`,
    ).all(key);
    out[key] = {
      total: base.total || 0,
      units: base.units || 0,
      lastUpdated: base.lastUpdated || null,
      periods,
    };
  }
  return out;
}

/* ---------------- 错误类型 ---------------- */

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.status = 404;
  }
}

export class LockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LockedError';
    this.status = 409;
  }
}

/**
 * 并发冲突：两个人改同一条记录，后到的那个带着过期的 rev。
 * 与 LockedError 都用 409，但 code 不同，前端要区分提示——
 * 一个是「这期已结账」，一个是「刷新后重试」。
 */
export class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
    this.status = 409;
    this.code = 'rev_conflict';
  }
}
