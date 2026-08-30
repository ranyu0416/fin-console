/**
 * 主数据（受控清单）：单位与项目。
 *
 * 为什么要有这一层：
 *   专项费用的计提链条按「单位|项目名称」串联各期记录，用上期累计开累
 *   推算本期产值。名称只要差一个字（多个空格、全角括号、"一分公司" 写成
 *   "1分公司"），链条就断成两条，上期基数变成 0，本期产值＝全部累计额，
 *   计提金额凭空翻倍，而且不会有任何报错。工会经费按「单位」串联，同理。
 *
 * 所以：单位与项目名称只能从这份清单里选，录入界面不给自由文本。
 * 清单本身由管理员维护，改名走 rename（连带更新历史台账），不是新建一条。
 */
import { nowIso, stmt, tx } from './db.js';
import { NAME_MAX, normalizeName } from './names.js';
import { MODULE_KEYS, MODULES } from './schema.js';
import { ValidationError } from './store.js';

// normalizeName 来自 lib/names.js，与 schema.js 落库时用的是同一个函数。
// 这一点是硬要求：校验用什么名字，就必须存什么名字，否则计提链条会静默断裂。
export { normalizeName };

function assertName(raw, label) {
  const name = normalizeName(raw);
  if (!name) throw new ValidationError(`${label}不能为空`);
  if (name.length > NAME_MAX) throw new ValidationError(`${label}不能超过 ${NAME_MAX} 个字`);
  return name;
}

/* ---------------- 单位 ---------------- */

export function listUnits({ includeInactive = false } = {}) {
  const where = includeInactive ? '' : 'WHERE active = 1';
  return stmt(`SELECT name, short_name, active, sort, note FROM org_units ${where} ORDER BY sort, name`).all().map((u) => ({
    name: u.name,
    shortName: u.short_name,
    active: !!u.active,
    sort: u.sort,
    note: u.note,
  }));
}

export function unitExists(name) {
  const n = normalizeName(name);
  if (!n) return false;
  return !!stmt('SELECT 1 FROM org_units WHERE name = ? AND active = 1').get(n);
}

export function addUnit({ name, shortName = '', sort = 0, note = '' }, actor) {
  const n = assertName(name, '单位名称');
  const existing = stmt('SELECT name, active FROM org_units WHERE name = ?').get(n);
  if (existing) {
    if (existing.active) throw new ValidationError(`单位「${n}」已在清单里`);
    // 曾停用过：重新启用而不是插入重复行
    stmt('UPDATE org_units SET active = 1, short_name = ?, sort = ?, note = ? WHERE name = ?').run(
      String(shortName || ''),
      Number(sort) || 0,
      String(note || ''),
      n,
    );
    return { name: n, reactivated: true };
  }
  stmt(
    `INSERT INTO org_units (name, short_name, active, sort, note, created_at, created_by)
     VALUES (?, ?, 1, ?, ?, ?, ?)`,
  ).run(n, String(shortName || ''), Number(sort) || 0, String(note || ''), nowIso(), actor || '');
  return { name: n, reactivated: false };
}

export function updateUnit(name, { shortName, sort, note, active }, actor) {
  const n = normalizeName(name);
  const row = stmt('SELECT name FROM org_units WHERE name = ?').get(n);
  if (!row) throw new ValidationError(`单位「${n}」不在清单里`);
  if (active === false) {
    // 停用前检查是否还有在用的项目
    const live = stmt('SELECT COUNT(*) AS n FROM org_projects WHERE unit = ? AND active = 1').get(n)?.n || 0;
    if (live > 0) throw new ValidationError(`「${n}」下还有 ${live} 个在用项目，请先停用这些项目`);
  }
  stmt(
    `UPDATE org_units SET
       short_name = COALESCE(?, short_name),
       sort       = COALESCE(?, sort),
       note       = COALESCE(?, note),
       active     = COALESCE(?, active)
     WHERE name = ?`,
  ).run(
    shortName === undefined ? null : String(shortName),
    sort === undefined ? null : Number(sort) || 0,
    note === undefined ? null : String(note),
    active === undefined ? null : (active ? 1 : 0),
    n,
  );
  return listUnits({ includeInactive: true }).find((u) => u.name === n);
}

/**
 * 单位改名：连带改写所有台账记录里的「单位」，保持计提链条不断。
 * 这是唯一正确的改名方式——直接新建一个名字会让历史数据留在旧名下。
 */
export function renameUnit(oldName, newName, actor) {
  const from = normalizeName(oldName);
  const to = assertName(newName, '新单位名称');
  if (from === to) throw new ValidationError('新旧名称相同');
  if (!stmt('SELECT 1 FROM org_units WHERE name = ?').get(from)) throw new ValidationError(`单位「${from}」不在清单里`);
  if (stmt('SELECT 1 FROM org_units WHERE name = ?').get(to)) throw new ValidationError(`单位「${to}」已存在，不能改成重名`);

  return tx(() => {
    stmt('UPDATE org_units SET name = ? WHERE name = ?').run(to, from);
    stmt('UPDATE org_projects SET unit = ? WHERE unit = ?').run(to, from);
    let touched = 0;
    for (const key of MODULE_KEYS) {
      const rows = stmt('SELECT id, props FROM records WHERE module = ? AND unit = ?').all(key, from);
      for (const row of rows) {
        let props;
        try {
          props = JSON.parse(row.props);
        } catch {
          continue;
        }
        props['单位'] = to;
        stmt('UPDATE records SET unit = ?, props = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(
          to,
          JSON.stringify(props),
          nowIso(),
          actor || '',
          row.id,
        );
        touched += 1;
      }
    }
    return { from, to, records: touched };
  });
}

/* ---------------- 项目 ---------------- */

export function listProjects({ unit = '', includeInactive = false } = {}) {
  const where = ['1=1'];
  const args = [];
  if (unit) {
    where.push('unit = ?');
    args.push(normalizeName(unit));
  }
  if (!includeInactive) where.push('active = 1');
  return stmt(`SELECT id, unit, name, rate, active, note FROM org_projects WHERE ${where.join(' AND ')} ORDER BY unit, name`)
    .all(...args)
    .map((p) => ({ id: p.id, unit: p.unit, name: p.name, rate: p.rate, active: !!p.active, note: p.note }));
}

export function projectExists(unit, name) {
  const u = normalizeName(unit);
  const n = normalizeName(name);
  if (!u || !n) return false;
  return !!stmt('SELECT 1 FROM org_projects WHERE unit = ? AND name = ? AND active = 1').get(u, n);
}

export function addProject({ unit, name, rate = null, note = '' }, actor) {
  const u = assertName(unit, '单位名称');
  const n = assertName(name, '项目名称');
  if (!unitExists(u)) throw new ValidationError(`单位「${u}」不在清单里，请先添加单位`);
  const existing = stmt('SELECT id, active FROM org_projects WHERE unit = ? AND name = ?').get(u, n);
  const rateNum = rate === null || rate === undefined || rate === '' ? null : Number(rate);
  if (rateNum !== null && (!Number.isFinite(rateNum) || rateNum < 0 || rateNum > 100)) {
    throw new ValidationError('计提比例需在 0～100 之间');
  }
  if (existing) {
    if (existing.active) throw new ValidationError(`「${u}」下已有项目「${n}」`);
    stmt('UPDATE org_projects SET active = 1, rate = ?, note = ? WHERE id = ?').run(rateNum, String(note || ''), existing.id);
    return { unit: u, name: n, reactivated: true };
  }
  stmt(
    `INSERT INTO org_projects (unit, name, rate, active, note, created_at, created_by)
     VALUES (?, ?, ?, 1, ?, ?, ?)`,
  ).run(u, n, rateNum, String(note || ''), nowIso(), actor || '');
  return { unit: u, name: n, reactivated: false };
}

export function updateProject(id, { rate, note, active }) {
  const row = stmt('SELECT id, unit, name FROM org_projects WHERE id = ?').get(Number(id));
  if (!row) throw new ValidationError('项目不存在');
  let rateNum;
  if (rate !== undefined) {
    rateNum = rate === null || rate === '' ? null : Number(rate);
    if (rateNum !== null && (!Number.isFinite(rateNum) || rateNum < 0 || rateNum > 100)) {
      throw new ValidationError('计提比例需在 0～100 之间');
    }
  }
  stmt(
    `UPDATE org_projects SET
       rate   = CASE WHEN ? THEN ? ELSE rate END,
       note   = COALESCE(?, note),
       active = COALESCE(?, active)
     WHERE id = ?`,
  ).run(
    rate === undefined ? 0 : 1,
    rateNum === undefined ? null : rateNum,
    note === undefined ? null : String(note),
    active === undefined ? null : (active ? 1 : 0),
    row.id,
  );
  return listProjects({ includeInactive: true }).find((p) => p.id === row.id);
}

/** 项目改名：同样连带改写专项费用台账里的「项目名称」 */
export function renameProject(id, newName, actor) {
  const row = stmt('SELECT id, unit, name FROM org_projects WHERE id = ?').get(Number(id));
  if (!row) throw new ValidationError('项目不存在');
  const to = assertName(newName, '新项目名称');
  if (row.name === to) throw new ValidationError('新旧名称相同');
  if (stmt('SELECT 1 FROM org_projects WHERE unit = ? AND name = ?').get(row.unit, to)) {
    throw new ValidationError(`「${row.unit}」下已有项目「${to}」`);
  }

  return tx(() => {
    stmt('UPDATE org_projects SET name = ? WHERE id = ?').run(to, row.id);
    let touched = 0;
    // 只有专项费用有「项目名称」字段
    for (const key of MODULE_KEYS) {
      if (!MODULES[key].fieldMap['项目名称']) continue;
      const rows = stmt('SELECT id, props FROM records WHERE module = ? AND unit = ?').all(key, row.unit);
      for (const rec of rows) {
        let props;
        try {
          props = JSON.parse(rec.props);
        } catch {
          continue;
        }
        if (props['项目名称'] !== row.name) continue;
        props['项目名称'] = to;
        stmt('UPDATE records SET props = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(
          JSON.stringify(props),
          nowIso(),
          actor || '',
          rec.id,
        );
        touched += 1;
      }
    }
    return { unit: row.unit, from: row.name, to, records: touched };
  });
}

/* ---------------- 从既有台账反向建清单 ---------------- */

/**
 * 扫描现有台账里出现过的 单位 / 项目名称，一次性灌入清单。
 * 用于系统已经录了数据、之后才启用受控清单的情况。
 * 同名归并，不会覆盖已有条目。
 */
export function seedFromRecords(actor) {
  const units = new Map();   // 规范名 -> 原始写法集合
  const projects = new Map(); // "单位|项目" -> {unit, name}

  for (const key of MODULE_KEYS) {
    const rows = stmt('SELECT props FROM records WHERE module = ?').all(key);
    for (const row of rows) {
      let props;
      try {
        props = JSON.parse(row.props);
      } catch {
        continue;
      }
      const u = normalizeName(props['单位']);
      if (u) {
        if (!units.has(u)) units.set(u, new Set());
        units.get(u).add(String(props['单位']));
      }
      const p = normalizeName(props['项目名称']);
      if (u && p) projects.set(`${u}|${p}`, { unit: u, name: p });
    }
  }

  return tx(() => {
    let addedUnits = 0;
    let addedProjects = 0;
    for (const name of units.keys()) {
      if (stmt('SELECT 1 FROM org_units WHERE name = ?').get(name)) continue;
      stmt(
        `INSERT INTO org_units (name, short_name, active, sort, note, created_at, created_by)
         VALUES (?, '', 1, 0, '由既有台账自动归集', ?, ?)`,
      ).run(name, nowIso(), actor || '');
      addedUnits += 1;
    }
    for (const { unit, name } of projects.values()) {
      if (stmt('SELECT 1 FROM org_projects WHERE unit = ? AND name = ?').get(unit, name)) continue;
      stmt(
        `INSERT INTO org_projects (unit, name, rate, active, note, created_at, created_by)
         VALUES (?, ?, NULL, 1, '由既有台账自动归集', ?, ?)`,
      ).run(unit, name, nowIso(), actor || '');
      addedProjects += 1;
    }
    // 提示可能存在的写法漂移：同一规范名对应多种原始写法
    const drift = [];
    for (const [name, variants] of units) {
      if (variants.size > 1) drift.push({ name, variants: [...variants] });
    }
    return { addedUnits, addedProjects, drift };
  });
}

/**
 * 清单里是否已经有内容。
 *
 * 受控清单默认开启，但清单为空时校验必须让路：新装的系统一条单位都没有，
 * 此时拦住所有录入等于让人无法开始用。管理员添加第一个单位（或点一次
 * 「从既有台账归集」）之后，强制校验自动生效——不需要额外开关。
 */
export function hasMasterData() {
  return !!stmt('SELECT 1 FROM org_units WHERE active = 1 LIMIT 1').get();
}

/**
 * 校验一条记录的 单位/项目名称 是否都在清单里；返回错误文本数组。
 *
 * 关于空值：以前写的是 `if (unit && !unitExists(unit))`，于是完全不填「单位」
 * 就能绕过全部校验——记录照样入库，unit 列是空串，按单位筛选查不到，
 * 但它仍然参与计提计算。既然模块声明了「单位」字段且清单已经建立，
 * 空值就应当被拒绝，而不是当作「没提交所以不用管」。
 */
export function validateMasterData(mod, data, { require: strict = true } = {}) {
  const errors = [];
  if (!strict) return errors;
  if (!hasMasterData()) return errors;   // 清单为空：尚未建立基准，放行
  const unit = normalizeName(data['单位']);
  if (mod.fieldMap['单位']) {
    if (!unit) {
      errors.push('「单位」不能为空，请从受控清单中选择');
    } else if (!unitExists(unit)) {
      errors.push(`单位「${unit}」不在受控清单里，请先由管理员在「单位/项目清单」中添加`);
    }
  }
  if (mod.fieldMap['项目名称']) {
    const proj = normalizeName(data['项目名称']);
    // 项目清单为空时放行：允许先只管住单位，项目边用边建。
    // 但只要该单位下已经建了项目，就说明基准已建立，此后空值与错字都要拦。
    const anyProject = unit
      ? !!stmt('SELECT 1 FROM org_projects WHERE unit = ? AND active = 1 LIMIT 1').get(unit)
      : false;
    if (unit && anyProject) {
      if (!proj) errors.push('「项目名称」不能为空，请从受控清单中选择');
      else if (!projectExists(unit, proj)) {
        errors.push(`「${unit}」下没有项目「${proj}」，请先在「单位/项目清单」中添加`);
      }
    }
  }
  return errors;
}
