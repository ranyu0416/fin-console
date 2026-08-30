/**
 * 服务端业务校验。
 *
 * 为什么要有这一层：录入表单里拦得住的规则（非负金额、期初接续成对、开累不回退、
 * 不重复录入），如果只在浏览器端存在，那么 REST API、粘贴导入、脚本迁移就全部绕过——
 * 实测负数原值、不成对的期初接续、比上期还小的开累都能一路落库，
 * 然后被摊销/计提算法算出看似自洽的错误金额。
 * 台账的价值在金额可信，所以同一套规则必须在服务端再兜一次。
 *
 * 约定：校验只针对「本次写进来的字段」（touched）。存量数据里可能已有历史脏数据，
 * 如果按合并后的整条记录校验，用户改个备注都会被历史错误拦住，等于把账锁死；
 * 按提交字段校验则新数据进不来，旧数据仍可正常编辑其它字段。
 * 管理员迁移（allowNewNames）可以整体跳过本模块，与跳过清单校验同一个通道、同一份审计。
 */
import { stmt } from './db.js';
import { validMonth } from './schema.js';

/** 不允许为负的金额/数量字段（按模块）。前端表单已拦一遍，这里是 API/导入的兜底。 */
const NON_NEGATIVE = {
  facility: ['原值(元)', '残值率(%)', '摊销期限(月)', '期初已摊销(元)'],
  asset: ['原值(元)', '残值率(%)', '预计使用年限(年)', '期初已折旧(元)'],
  baddebt: ['科目余额(元)', '计提比例(%)', '已计提金额(元)'],
  lvc: ['数量', '单价(元)', '可抵扣进项税额(元)'],
  levy: ['累计产值(元)', '计提比例(%)', '期初已计提(元)', '上期累计产值(元)'],
  union: ['工资年开累(元)', '工会经费比例(%)', '职工教育经费比例(%)', '工会期初已计提(元)', '教育期初已计提(元)', '上期工资年开累(元)'],
  balance: ['期初借方(元)', '期初贷方(元)', '本期借方发生(元)', '本期贷方发生(元)', '期末借方余额(元)', '期末贷方余额(元)'],
  rnd: ['金额(元)'],
  labor: ['借方发生(元)', '贷方发生(元)'],
  contract: ['合同金额(元)', '变更后金额(元)', '累计计价(元)', '累计开票(元)', '累计付款(元)'],
  party: ['期初余额(元)', '本期借方发生(元)', '本期贷方发生(元)', '期末余额(元)'],
  staffpay: ['在册人数', '应发工资(元)', '专户代发(元)', '其他支付(元)'],
  invoice: ['金额(元)', '税额(元)'],
  bank: ['期初余额(元)', '本期收入(元)', '本期支出(元)', '期末余额(元)'],
  deposit: ['缴纳金额(元)', '已退还(元)', '余额(元)'],
  material: ['期初结存(元)', '本期入库(元)', '本期出库(元)', '期末结存(元)'],
  machinery: ['不含税计价(元)', '进项税额(元)', '含税合计(元)'],
  consumable: ['数量', '原值(元)', '本期摊销(元)'],
};

/** 百分比字段：0～100 */
const PERCENT_FIELDS = ['残值率(%)', '计提比例(%)', '工会经费比例(%)', '职工教育经费比例(%)'];

/** 必须为正（>0）的字段，与录入表单的口径一致 */
const POSITIVE = {
  facility: ['原值(元)'],
  asset: ['原值(元)'],
  baddebt: ['科目余额(元)'],
  lvc: ['数量'],
};

/** 链式计提模块：身份字段、累计字段、唯一键 */
const CHAIN = {
  levy: { cum: '累计产值(元)', identity: (r) => String(r['单位'] || '') + '|' + String(r['项目名称'] || ''), label: '累计产值(元)' },
  union: { cum: '工资年开累(元)', identity: (r) => String(r['单位'] || ''), label: '工资年开累(元)' },
};

/** 业务主键去重：与前端 dupKey 同一套键，保证「界面上进不来的」API/导入也进不来 */
const DUP_KEY = {
  levy: {
    identity: (r) => String(r['单位'] || '') + '|' + String(r['项目名称'] || ''),
    hint: '同一单位、同一项目、同一会计期间',
  },
  union: {
    identity: (r) => String(r['单位'] || ''),
    hint: '同一单位、同一会计期间',
  },
};

function ymOf(value) {
  const s = String(value || '').slice(0, 7);
  return validMonth(s) ? s : '';
}

function isTouched(touched, names) {
  if (!touched) return true;          // 未声明 = 全部字段都是本次写入（新增/导入）
  return names.some((n) => touched.has(n));
}

/** 期初接续（facility / asset）：两项必须成对，且金额不超应摊总额、期间不早于启用月 */
function openingErrors(rec, amtField, label) {
  const errs = [];
  const openAmt = Number(rec[amtField]);
  const openYm = ymOf(rec['期初截止期间']);
  const hasAmt = Number.isFinite(openAmt) && openAmt > 0;
  if (hasAmt !== !!openYm) {
    errs.push(`「${label}」与「期初截止期间」必须成对填写：填了金额就要填截至哪一期，填了期间就要填金额`);
    return errs;
  }
  if (!hasAmt) return errs;
  const cost = Number(rec['原值(元)']);
  if (Number.isFinite(cost) && cost > 0) {
    const total = cost * (1 - (Number(rec['残值率(%)']) || 0) / 100);
    if (openAmt > total + 0.005) {
      errs.push(`期初${label}（${openAmt}）不能大于应摊总额（${Math.round(total * 100) / 100}）`);
    }
  }
  const start = ymOf(rec['启用日期']);
  if (start && openYm < start) {
    errs.push('期初截止期间不能早于启用日期所在月');
  }
  return errs;
}

/** 链式计提（levy / union）：累计字段相对前后期间必须单调不减 */
function chainErrors(mod, rec, excludeId) {
  const cfg = CHAIN[mod.key];
  if (!cfg) return [];
  const period = mod.periodField ? ymOf(rec[mod.periodField]) : '';
  if (!period) return [];
  const cum = Number(rec[cfg.cum]);
  if (!Number.isFinite(cum)) return [];
  const identity = cfg.identity(rec);
  if (!identity.replace(/\|/g, '')) return [];

  const rows = stmt('SELECT id, period, props FROM records WHERE module = ? AND unit = ?').all(mod.key, String(rec['单位'] || ''));
  let prevYm = '', prevCum = null;
  let nextYm = '', nextCum = null;
  for (const row of rows) {
    if (excludeId && row.id === excludeId) continue;
    const ym = String(row.period || '').slice(0, 7);
    if (!validMonth(ym)) continue;
    let props = {};
    try { props = JSON.parse(row.props); } catch { continue; }
    if (cfg.identity(props) !== identity) continue;
    const c = Number(props[cfg.cum]);
    if (!Number.isFinite(c)) continue;
    if (ym < period && (ym > prevYm || (ym === prevYm && (prevCum === null || c > prevCum)))) {
      prevYm = ym; prevCum = c;
    }
    if (ym > period && (!nextYm || ym < nextYm || (ym === nextYm && c < nextCum))) {
      nextYm = ym; nextCum = c;
    }
  }
  const errs = [];
  if (prevCum !== null && cum < prevCum) {
    errs.push(`${cfg.label}（${cum}）不能小于上期 ${prevYm}（${prevCum}）——开累倒挂会把当期产值算错`);
  }
  if (nextCum !== null && nextCum < cum) {
    errs.push(`${cfg.label}（${cum}）不能大于下期 ${nextYm}（${nextCum}）——回填历史期间不能超过后期已录的开累`);
  }
  return errs;
}

/** 业务主键去重：同一链上同一期只允许一条 */
function dupErrors(mod, rec, excludeId) {
  const cfg = DUP_KEY[mod.key];
  if (!cfg) return [];
  const period = mod.periodField ? ymOf(rec[mod.periodField]) : '';
  if (!period) return [];
  const identity = cfg.identity(rec);
  if (!identity.replace(/\|/g, '')) return [];
  const rows = stmt('SELECT id, period, props FROM records WHERE module = ? AND unit = ?').all(mod.key, String(rec['单位'] || ''));
  for (const row of rows) {
    if (excludeId && row.id === excludeId) continue;
    if (String(row.period || '').slice(0, 7) !== period) continue;
    let props = {};
    try { props = JSON.parse(row.props); } catch { continue; }
    if (cfg.identity(props) === identity) {
      return [`${mod.name}：${cfg.hint}已有记录，如需修改请编辑原记录，不要重复新增`];
    }
  }
  return [];
}

/**
 * 对一条（合并后的）记录做业务校验，返回错误文本数组（空数组 = 通过）。
 * @param rec      合并后的扁平记录（字段名 → 值）
 * @param touched  本次显式写入的字段名集合；null 表示全部字段（新增/导入）
 * @param excludeId 更新时排除自身（乐观锁场景下同一记录不算重复）
 */
export function businessErrors(mod, rec, { touched = null, excludeId = null } = {}) {
  const errs = [];
  if (!rec || typeof rec !== 'object') return errs;

  for (const f of NON_NEGATIVE[mod.key] || []) {
    if (!isTouched(touched, [f])) continue;
    const v = Number(rec[f]);
    if (Number.isFinite(v) && v < 0) errs.push(`字段「${f}」不能为负数`);
  }
  for (const f of PERCENT_FIELDS) {
    if (!isTouched(touched, [f])) continue;
    const v = Number(rec[f]);
    if (Number.isFinite(v) && v > 100) errs.push(`字段「${f}」需在 0～100 之间`);
  }
  for (const f of POSITIVE[mod.key] || []) {
    if (!isTouched(touched, [f])) continue;
    const v = Number(rec[f]);
    if (Number.isFinite(v) && v <= 0) errs.push(`字段「${f}」必须大于 0`);
  }
  if (mod.key === 'facility') {
    if (isTouched(touched, ['摊销期限(月)'])) {
      const v = Number(rec['摊销期限(月)']);
      if (Number.isFinite(v) && v < 1) errs.push('字段「摊销期限(月)」不能小于 1');
    }
    if (isTouched(touched, ['期初已摊销(元)', '期初截止期间'])) {
      errs.push(...openingErrors(rec, '期初已摊销(元)', '已摊销'));
    }
  }
  if (mod.key === 'asset') {
    if (isTouched(touched, ['预计使用年限(年)'])) {
      const v = Number(rec['预计使用年限(年)']);
      if (Number.isFinite(v) && v <= 0) errs.push('字段「预计使用年限(年)」必须大于 0');
    }
    if (isTouched(touched, ['期初已折旧(元)', '期初截止期间'])) {
      errs.push(...openingErrors(rec, '期初已折旧(元)', '已折旧'));
    }
  }
  if (CHAIN[mod.key] && isTouched(touched, [CHAIN[mod.key].cum, mod.periodField, ...(mod.key === 'levy' ? ['项目名称'] : []), '单位'])) {
    errs.push(...chainErrors(mod, rec, excludeId));
  }
  if (DUP_KEY[mod.key] && isTouched(touched, [mod.periodField, '单位', ...(mod.key === 'levy' ? ['项目名称'] : [])])) {
    errs.push(...dupErrors(mod, rec, excludeId));
  }
  return errs;
}
