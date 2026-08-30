/**
 * 本月结转：把上一期的「单位 + 项目」名册整份克隆到本期，只留新数字待填。
 *
 * 解决的痛点：每月开新期时，用户要把上期的单位、项目名、计提比例逐条重打一遍
 * （原来是从 Excel 粘贴）。手打就会有错字，错字会把计提链条打断，导致计提翻倍。
 * 结转直接复用上期记录里的名称与比例，用户只需要填这一期的新外部数字。
 *
 * 各模块的「新数字」是哪一列：
 *   levy  累计产值(元)  —— 本期开累产值
 *   union   工资年开累(元)    —— 本期工资年开累
 *   lvc     数量             —— 本期领用数量（单价与规格沿用上期）
 *   凡是有 periodField 的模块都该能结转；没有的（facility/asset/baddebt）是常设台账，
 *   记录一直挂着不按期重录，本来就不需要结转。
 */
import { nowIso, stmt, tx } from './db.js';
import { MODULES } from './schema.js';
import { ValidationError } from './store.js';
import { randomBytes } from 'node:crypto';

/** 可结转的模块，以及结转时要清空、等用户填的字段 */
export const CARRY_MODULES = Object.freeze({
  levy: {
    // 名册身份：这几个字段唯一确定一条「同一个东西」
    identity: ['单位', '项目名称'],
    // 沿用上期的字段
    carry: ['单位', '项目名称', '计提比例(%)'],
    // 需要用户填的新数字（结转后留空）
    input: '累计产值(元)',
    inputLabel: '本期累计产值（开累产值）',
    // 上期该字段的值，作为参考显示，也作为「不能小于上期」的下限
    reference: '累计产值(元)',
    // 累计口径：本期值不能小于上期，否则本期发生额为负
    cumulative: true,
  },
  union: {
    identity: ['单位'],
    carry: ['单位', '工会经费比例(%)', '职工教育经费比例(%)'],
    input: '工资年开累(元)',
    inputLabel: '本期工资年开累',
    reference: '工资年开累(元)',
    cumulative: true,
  },
  /*
   * 低值易耗品是一次转销：每期领用哪些东西是新的，但「领用什么、什么规格、
   * 单价多少、谁领、摊到哪个成本对象」这些每期高度重复，手打同样会打错
   * 成本对象和单位名——错了照样进不了正确的归集。所以名册照抄，只留数量待填。
   * identity 用「单位 + 资产名称 + 规格型号」：同一单位同名不同规格是两样东西。
   */
  lvc: {
    identity: ['单位', '资产名称', '规格型号'],
    carry: ['单位', '资产名称', '规格型号', '计量单位', '单价(元)', '领用人', '成本对象'],
    input: '数量',
    inputLabel: '本期领用数量',
    reference: '数量',
    /* 当期发生数，不是累计数：这月领得比上月少是正常的，不能拿上期做下限 */
    cumulative: false,
  },
});

const MONTH_RE = /^\d{4}-\d{2}$/;

function newId(moduleKey) {
  return `${moduleKey}_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
}

function prevPeriod(ym) {
  const y = +ym.slice(0, 4);
  const m = +ym.slice(5, 7);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function parseProps(row) {
  try {
    return JSON.parse(row.props);
  } catch {
    return null;
  }
}

function identityOf(cfg, props) {
  return cfg.identity.map((f) => String(props[f] ?? '').trim()).join('|');
}

/**
 * 预览结转：算出会新增哪些行、跳过哪些行，不写库。
 * @returns {{module, from, to, items: Array, skipped: Array}}
 */
export function previewCarry(moduleKey, toPeriod, { fromPeriod = '' } = {}) {
  const cfg = CARRY_MODULES[moduleKey];
  if (!cfg) throw new ValidationError(`「${MODULES[moduleKey]?.name || moduleKey}」不是按月记录的模块，不需要结转`);
  if (!MONTH_RE.test(String(toPeriod))) throw new ValidationError('目标期间格式必须是 YYYY-MM');
  const from = fromPeriod || prevPeriod(toPeriod);
  if (!MONTH_RE.test(from)) throw new ValidationError('来源期间格式必须是 YYYY-MM');
  if (from >= toPeriod) throw new ValidationError('来源期间必须早于目标期间');

  const mod = MODULES[moduleKey];
  const srcRows = stmt('SELECT id, props FROM records WHERE module = ? AND period = ?').all(moduleKey, from);
  const dstRows = stmt('SELECT props FROM records WHERE module = ? AND period = ?').all(moduleKey, toPeriod);

  const already = new Set();
  for (const row of dstRows) {
    const props = parseProps(row);
    if (props) already.add(identityOf(cfg, props));
  }

  const items = [];
  const skipped = [];
  const seen = new Set();

  for (const row of srcRows) {
    const props = parseProps(row);
    if (!props) continue;
    const id = identityOf(cfg, props);
    if (!id.replace(/\|/g, '')) {
      skipped.push({ identity: id, reason: '来源记录缺少单位/项目名称' });
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    if (already.has(id)) {
      skipped.push({ identity: id, reason: `${toPeriod} 已有这条记录` });
      continue;
    }
    // 已完工/已关闭的不再结转。只认显式的完成标记（已字头）——
    // 以前用 /完工|已结束|已关闭|停工/ 做子串匹配，「未完工」「尚未完工」
    // 「阶段性完工(未竣工)」都会被当成已完工跳过：结转名册少一条、
    // 漏录提醒也不报（两者共用这里的口径），该项目当月计提静默缺失。
    // 「竣工待结算」这类没有「已」字头的写法会照常结转，宁可多提也不漏提；
    // 确实要停的项目把备注写成「已完工 / 已竣工」即可。
    const note = String(props['备注'] || '');
    if (/已完工|已竣工|已结束|已关闭|停工/.test(note)) {
      skipped.push({ identity: id, reason: `上期备注标记为「${note}」` });
      continue;
    }

    const carried = {};
    for (const f of cfg.carry) {
      if (props[f] !== undefined && props[f] !== null && props[f] !== '') carried[f] = props[f];
    }
    items.push({
      identity: id,
      unit: String(props['单位'] || ''),
      /*
       * 名册第二列显示什么：levy 是项目名称，lvc 没有项目、要显示资产名称+规格。
       * 用 identity 里除「单位」之外的字段拼出来，这样新加可结转模块时不用改这里。
       */
      project: cfg.identity
        .filter((f) => f !== '单位')
        .map((f) => String(props[f] ?? '').trim())
        .filter(Boolean)
        .join(' · '),
      carried,
      reference: props[cfg.reference] ?? null,
      inputField: cfg.input,
      inputLabel: cfg.inputLabel,
    });
  }

  return {
    module: moduleKey,
    moduleName: mod.name,
    from,
    to: toPeriod,
    periodField: mod.periodField,
    /* 界面据此决定要不要提示「不能小于上期」 */
    cumulative: !!cfg.cumulative,
    items,
    skipped,
  };
}

/**
 * 漏录检查：上期有、本期还没有的名册条目。
 *
 * 为什么需要它：结转解决的是「照抄上期名册」，但只在用户主动点结转时才发生。
 * 没有任何机制做反向检查——上期 20 个项目、本期只录了 18 个，
 * 系统不会有任何表示，直到有人拿总数对账才发现少了两个项目的计提。
 * 少计提和算错一样是错报，而且更难发现，因为账面上每一条都是对的。
 *
 * 复用 previewCarry 的口径（同样的 identity、同样跳过已完工的），
 * 所以「该提醒的」和「结转会补的」永远是同一批，不会出现提醒了却结转不出来。
 *
 * @returns {{module, from, to, missing: Array<{identity, unit, project}>, count}}
 */
export function missingEntries(moduleKey, toPeriod, { fromPeriod = '' } = {}) {
  const preview = previewCarry(moduleKey, toPeriod, { fromPeriod });
  return {
    module: moduleKey,
    moduleName: preview.moduleName,
    from: preview.from,
    to: preview.to,
    missing: preview.items.map((it) => ({
      identity: it.identity,
      unit: it.unit,
      project: it.project,
    })),
    count: preview.items.length,
  };
}

/**
 * 全部可结转模块的漏录情况，供总览页一次性展示。
 * 上期本来就没数据的模块（首次使用、或该模块还没开始用）不提醒——
 * 那不是漏录，是还没开始，提醒了只会变成噪音。
 */
export function missingEntriesAll(toPeriod, { fromPeriod = '' } = {}) {
  const out = {};
  for (const key of Object.keys(CARRY_MODULES)) {
    try {
      const r = missingEntries(key, toPeriod, { fromPeriod });
      if (r.count > 0) out[key] = r;
    } catch {
      /* 期间格式等参数问题：这是提醒功能，不该因为它让总览页整体失败 */
    }
  }
  return out;
}

/**
 * 执行结转：按预览结果批量插入本期记录。
 * values 是 { identity: 新数字 }；没给值的行以空白落库，用户之后再填。
 * 允许留空是有意的：用户可能先把名册结转出来，再慢慢填数字。
 */
export function applyCarry(moduleKey, toPeriod, values, actor, { fromPeriod = '' } = {}) {
  const preview = previewCarry(moduleKey, toPeriod, { fromPeriod });
  const cfg = CARRY_MODULES[moduleKey];
  const mod = MODULES[moduleKey];
  const vals = values && typeof values === 'object' ? values : {};

  const errors = [];
  // 先整体校验，避免写一半失败
  for (const item of preview.items) {
    const raw = vals[item.identity];
    if (raw === undefined || raw === null || raw === '') continue;
    const n = Number(String(raw).replace(/[,\s]/g, ''));
    if (!Number.isFinite(n)) {
      errors.push(`${item.identity}：「${cfg.inputLabel}」不是有效数字`);
      continue;
    }
    if (n < 0) errors.push(`${item.identity}：「${cfg.inputLabel}」不能为负数`);
    /*
     * 开累类字段不能比上期还小，否则本期产值算成负数。
     * 但这条只对「累计口径」的字段成立（levy 的开累产值、union 的工资年开累）——
     * lvc 的「本期领用数量」是当期发生数，上月领 10 个这月领 2 个完全正常，
     * 拿它去比上期会把正常录入拦下来。所以由模块自己声明 cumulative。
     */
    if (cfg.cumulative && item.reference != null && n < Number(item.reference)) {
      errors.push(`${item.identity}：本期开累 ${n} 小于上期 ${item.reference}，请核对`);
    }
  }
  if (errors.length) throw new ValidationError(errors.join('；'));

  return tx(() => {
    let inserted = 0;
    for (const item of preview.items) {
      const props = { ...item.carried };
      if (mod.periodField) props[mod.periodField] = `${toPeriod}-01`;
      const raw = vals[item.identity];
      if (raw !== undefined && raw !== null && raw !== '') {
        props[cfg.input] = Number(String(raw).replace(/[,\s]/g, ''));
      }
      // 上期开累作为本期的推算基数写进备注区之外的字段：levy 用「上期累计产值(元)」
      // 只有在本期是该链条第一条记录时才需要，这里不写——calcAll 会自己从上期记录推。
      const at = nowIso();
      stmt(
        `INSERT INTO records (id, module, unit, period, props, created_at, created_by, updated_at, updated_by, rev)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(
        newId(moduleKey),
        moduleKey,
        String(props['单位'] || ''),
        toPeriod,
        JSON.stringify(props),
        at,
        actor || '',
        at,
        actor || '',
      );
      inserted += 1;
    }
    return { module: moduleKey, from: preview.from, to: toPeriod, inserted, skipped: preview.skipped.length };
  });
}
