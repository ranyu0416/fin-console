/**
 * 服务端权威字段定义。
 * 字段名与前端 财务管理台 页面里 r['字段名'] 完全一致，一个字都不能改。
 * legacyDbId 是页面 MODULES[x].dbId 的历史取值，保留映射后前端无需改动即可联机。
 */
import { CONTROLLED_NAME_FIELDS, NAME_MAX, nameTooLong, normalizeName } from './names.js';

const MODULE_LIST = [
  {
    key: 'facility',
    name: '设施摊销',
    entity: '设施',
    legacyDbId: 'ImZmbLHPiJNk65y1b28JUi',
    sortField: '启用日期',
    periodField: null,
    fields: [
      { name: '设施编号', type: 'text' },
      { name: '单位', type: 'text' },
      { name: '设施名称', type: 'text' },
      { name: '设施类别', type: 'select', options: ['房屋类设施', '构筑物类设施', '其他设施'] },
      { name: '成本对象', type: 'text' },
      { name: '入账日期', type: 'date' },
      { name: '启用日期', type: 'date' },
      { name: '原值(元)', type: 'number' },
      { name: '残值率(%)', type: 'number' },
      { name: '摊销期限(月)', type: 'number' },
      { name: '摊销方法', type: 'select', options: ['直线法', '一次性摊销'] },
      { name: '状态', type: 'select', options: ['使用中', '已摊完', '已清理'] },
      // 期初接续：从纸质/旧台账切过来时，一次性填写截至某期已摊多少，之后按月自动接着摊
      { name: '期初已摊销(元)', type: 'number' },
      { name: '期初截止期间', type: 'date' },
      { name: '备注', type: 'text' },
    ],
  },
  {
    key: 'levy',
    name: '专项费用',
    entity: '专项费用',
    legacyDbId: 'zRoJgoLy94atKsUs2EgxVD',
    sortField: '会计期间',
    periodField: '会计期间',
    fields: [
      { name: '单位', type: 'text' },
      { name: '项目名称', type: 'text' },
      { name: '会计期间', type: 'date' },
      { name: '累计产值(元)', type: 'number' },
      { name: '计提比例(%)', type: 'number' },
      { name: '期初已计提(元)', type: 'number' },
      { name: '上期累计产值(元)', type: 'number' },
      { name: '备注', type: 'text' },
    ],
  },
  {
    key: 'union',
    name: '工会·职工教育经费',
    entity: '经费记录',
    legacyDbId: 'GiF7wUN4JMswc6S1qxE0G1',
    sortField: '会计期间',
    periodField: '会计期间',
    fields: [
      { name: '单位', type: 'text' },
      { name: '会计期间', type: 'date' },
      { name: '工资年开累(元)', type: 'number' },
      { name: '工会经费比例(%)', type: 'number' },
      { name: '职工教育经费比例(%)', type: 'number' },
      { name: '工会期初已计提(元)', type: 'number' },
      { name: '教育期初已计提(元)', type: 'number' },
      { name: '上期工资年开累(元)', type: 'number' },
      { name: '备注', type: 'text' },
    ],
  },
  {
    key: 'asset',
    name: '固定资产折旧',
    entity: '固定资产',
    legacyDbId: 'OsbSuKrkilBcn6NwxH9aNk',
    sortField: '启用日期',
    periodField: null,
    fields: [
      { name: '单位', type: 'text' },
      { name: '固定资产编号', type: 'text' },
      { name: '资产名称', type: 'text' },
      { name: '资产类型', type: 'select', options: ['房屋构筑物', '机械设备', '运输设备', '电子设备', '其他'] },
      { name: '原值(元)', type: 'number' },
      { name: '残值率(%)', type: 'number' },
      { name: '预计使用年限(年)', type: 'number' },
      { name: '启用日期', type: 'date' },
      { name: '转移至项目日期', type: 'date' },
      { name: '状态', type: 'select', options: ['使用中', '已提完', '已处置'] },
      // 期初接续：同 facility，用于把旧账的开累折旧接进来
      { name: '期初已折旧(元)', type: 'number' },
      { name: '期初截止期间', type: 'date' },
      { name: '备注', type: 'text' },
    ],
  },
  {
    key: 'baddebt',
    name: '减值准备',
    entity: '减值准备记录',
    legacyDbId: '35BkFUlmrgQIjLqUue7bW3',
    sortField: '入账日期',
    periodField: null,
    fields: [
      { name: '单位', type: 'text' },
      { name: '科目名称', type: 'text' },
      { name: '往来单位名称', type: 'text' },
      { name: '入账日期', type: 'date' },
      { name: '科目余额(元)', type: 'number' },
      { name: '计提比例(%)', type: 'number' },
      { name: '已计提金额(元)', type: 'number' },
    ],
  },
  {
    key: 'lvc',
    name: '低值易耗品',
    entity: '低值易耗品',
    legacyDbId: 'toCvtWLBIbwZTBy7Q0pH0y',
    sortField: '入账月份',
    periodField: '入账月份',
    fields: [
      { name: '单位', type: 'text' },
      { name: '资产名称', type: 'text' },
      { name: '入账月份', type: 'date' },
      { name: '凭证号', type: 'text' },
      { name: '开票日期', type: 'date' },
      { name: '规格型号', type: 'text' },
      { name: '计量单位', type: 'text' },
      { name: '数量', type: 'number' },
      { name: '单价(元)', type: 'number' },
      { name: '可抵扣进项税额(元)', type: 'number' },
      { name: '领用人', type: 'text' },
      { name: '成本对象', type: 'text' },
    ],
  },
  {
    key: 'balance',
    name: '科目余额表',
    entity: '余额记录',
    legacyDbId: 'balance',
    sortField: '科目代码',
    periodField: '会计期间',
    fields: [
      { name: '会计期间', type: 'date' },
      { name: '科目代码', type: 'text' },
      { name: '科目名称', type: 'text' },
      { name: '期初借方(元)', type: 'number' },
      { name: '期初贷方(元)', type: 'number' },
      { name: '本期借方发生(元)', type: 'number' },
      { name: '本期贷方发生(元)', type: 'number' },
      { name: '期末借方余额(元)', type: 'number' },
      { name: '期末贷方余额(元)', type: 'number' },
      { name: '备注', type: 'text' },
    ],
  },
  {
    key: 'rnd',
    name: '研发费用台账',
    entity: '研发费用记录',
    legacyDbId: 'rnd',
    sortField: '会计期间',
    periodField: '会计期间',
    fields: [
      { name: '会计期间', type: 'date' },
      { name: '项目', type: 'text' },
      { name: '费用大类', type: 'select', options: ['人员人工', '直接投入', '折旧摊销', '设计试验', '其他'] },
      { name: '科目代码', type: 'text' },
      { name: '科目名称', type: 'text' },
      { name: '凭证字号', type: 'text' },
      { name: '凭证日期', type: 'date' },
      { name: '研发项目', type: 'text' },
      { name: '制单人', type: 'text' },
      { name: '单据', type: 'text' },
      { name: '摘要', type: 'text' },
      { name: '金额(元)', type: 'number' },
      { name: '备注', type: 'text' },
    ],
  },
  {
    key: 'labor',
    name: '人工费台账',
    entity: '人工费记录',
    legacyDbId: 'labor',
    sortField: '会计期间',
    periodField: '会计期间',
    fields: [
      { name: '会计期间', type: 'date' },
      { name: '项目', type: 'text' },
      { name: '费用性质', type: 'select', options: ['职工薪酬', '社保公积金', '劳务费', '其他'] },
      { name: '科目代码', type: 'text' },
      { name: '科目名称', type: 'text' },
      { name: '凭证字号', type: 'text' },
      { name: '凭证日期', type: 'date' },
      { name: '制单人', type: 'text' },
      { name: '单据', type: 'text' },
      { name: '摘要', type: 'text' },
      { name: '借方发生(元)', type: 'number' },
      { name: '贷方发生(元)', type: 'number' },
      { name: '备注', type: 'text' },
    ],
  },
  {
    key: 'contract',
    name: '合同台账',
    entity: '合同记录',
    legacyDbId: 'contract',
    sortField: '签订日期',
    periodField: null,
    fields: [
      { name: '合同编号', type: 'text' },
      { name: '合同名称', type: 'text' },
      { name: '合同类别', type: 'select', options: ['劳务外包', '专业外包', '材料采购', '机械租赁', '其他'] },
      { name: '对方单位', type: 'text' },
      { name: '签订日期', type: 'date' },
      { name: '合同金额(元)', type: 'number' },
      { name: '变更后金额(元)', type: 'number' },
      { name: '累计计价(元)', type: 'number' },
      { name: '累计开票(元)', type: 'number' },
      { name: '累计付款(元)', type: 'number' },
      { name: '备注', type: 'text' },
    ],
  },
  {
    key: 'party',
    name: '往来单位台账',
    entity: '往来记录',
    legacyDbId: 'party',
    sortField: '会计期间',
    periodField: '会计期间',
    fields: [
      { name: '会计期间', type: 'date' },
      { name: '往来单位', type: 'text' },
      { name: '往来性质', type: 'select', options: ['应付购货款', '应付劳务款', '应付结算款', '应付固定资产款', '预付购货款', '应收账款', '保证金', '其他'] },
      { name: '科目代码', type: 'text' },
      { name: '期初余额(元)', type: 'number' },
      { name: '本期借方发生(元)', type: 'number' },
      { name: '本期贷方发生(元)', type: 'number' },
      { name: '期末余额(元)', type: 'number' },
      { name: '余额方向', type: 'select', options: ['借', '贷', '平'] },
      { name: '备注', type: 'text' },
    ],
  },
  {
    key: 'staffpay',
    name: '劳务工资台账',
    entity: '劳务工资记录',
    legacyDbId: 'staffpay',
    sortField: '会计期间',
    periodField: '会计期间',
    fields: [
      { name: '会计期间', type: 'date' },
      { name: '劳务队/班组', type: 'text' },
      { name: '在册人数', type: 'number' },
      { name: '应发工资(元)', type: 'number' },
      { name: '专户代发(元)', type: 'number' },
      { name: '其他支付(元)', type: 'number' },
      { name: '备注', type: 'text' },
    ],
  },
  {
    key: 'invoice',
    name: '进项发票台账',
    entity: '发票记录',
    legacyDbId: 'invoice',
    sortField: '会计期间',
    periodField: '会计期间',
    fields: [
      { name: '会计期间', type: 'date' },
      { name: '发票类型', type: 'select', options: ['增值税专用发票', '增值税普通发票', '其他'] },
      { name: '发票号码', type: 'text' },
      { name: '开票方', type: 'text' },
      { name: '开票日期', type: 'date' },
      { name: '金额(元)', type: 'number' },
      { name: '税额(元)', type: 'number' },
      { name: '认证状态', type: 'select', options: ['已认证', '待认证', '待取得'] },
      { name: '关联凭证字号', type: 'text' },
      { name: '备注', type: 'text' },
    ],
  },
  {
    key: 'bank',
    name: '银行资金台账',
    entity: '资金记录',
    legacyDbId: 'bank',
    sortField: '会计期间',
    periodField: '会计期间',
    fields: [
      { name: '会计期间', type: 'date' },
      { name: '账户', type: 'text' },
      { name: '期初余额(元)', type: 'number' },
      { name: '本期收入(元)', type: 'number' },
      { name: '本期支出(元)', type: 'number' },
      { name: '期末余额(元)', type: 'number' },
      { name: '备注', type: 'text' },
    ],
  },
  {
    key: 'deposit',
    name: '保证金台账',
    entity: '保证金记录',
    legacyDbId: 'deposit',
    sortField: '会计期间',
    periodField: '会计期间',
    fields: [
      { name: '会计期间', type: 'date' },
      { name: '保证金类别', type: 'select', options: ['投标保证金', '履约保证金', '劳务工资保证金', '其他保证金'] },
      { name: '缴纳对象', type: 'text' },
      { name: '缴纳金额(元)', type: 'number' },
      { name: '已退还(元)', type: 'number' },
      { name: '余额(元)', type: 'number' },
      { name: '到期日', type: 'date' },
      { name: '备注', type: 'text' },
    ],
  },
  {
    key: 'material',
    name: '材料收发存台账',
    entity: '收发存记录',
    legacyDbId: 'material',
    sortField: '会计期间',
    periodField: '会计期间',
    fields: [
      { name: '会计期间', type: 'date' },
      { name: '材料类别', type: 'text' },
      { name: '科目代码', type: 'text' },
      { name: '期初结存(元)', type: 'number' },
      { name: '本期入库(元)', type: 'number' },
      { name: '本期出库(元)', type: 'number' },
      { name: '期末结存(元)', type: 'number' },
      { name: '备注', type: 'text' },
    ],
  },
  {
    key: 'machinery',
    name: '机械租赁台账',
    entity: '机械租赁记录',
    legacyDbId: 'machinery',
    sortField: '会计期间',
    periodField: '会计期间',
    fields: [
      { name: '会计期间', type: 'date' },
      { name: '出租单位', type: 'text' },
      { name: '设备/机具', type: 'text' },
      { name: '计价说明', type: 'text' },
      { name: '不含税计价(元)', type: 'number' },
      { name: '进项税额(元)', type: 'number' },
      { name: '含税合计(元)', type: 'number' },
      { name: '凭证字号', type: 'text' },
      { name: '备注', type: 'text' },
    ],
  },
  {
    key: 'consumable',
    name: '周转物资台账',
    entity: '周转物资记录',
    legacyDbId: 'consumable',
    sortField: '会计期间',
    periodField: '会计期间',
    fields: [
      { name: '会计期间', type: 'date' },
      { name: '物资名称', type: 'text' },
      { name: '规格型号', type: 'text' },
      { name: '数量', type: 'number' },
      { name: '原值(元)', type: 'number' },
      { name: '摊销方法', type: 'select', options: ['分次摊销', '一次性摊销'] },
      { name: '本期摊销(元)', type: 'number' },
      { name: '在用状态', type: 'select', options: ['在库', '在用', '已摊完', '已报废'] },
      { name: '备注', type: 'text' },
    ],
  },
];

/**
 * 模块注册表。
 *
 * 内层条目仍然冻结（fieldMap 不可变，防止运行时被随手改字段名），
 * 但外层容器不再冻结：界面「新建模块」功能要在运行时把管理员自定义的
 * 模块注册进来（registerCustomModule），冻结外层会让动态模块无处安放。
 */
export const MODULES = Object.fromEntries(
  MODULE_LIST.map((m) => [
    m.key,
    Object.freeze({
      ...m,
      fieldMap: Object.freeze(Object.fromEntries(m.fields.map((f) => [f.name, f]))),
    }),
  ]),
);

export const MODULE_KEYS = MODULE_LIST.map((m) => m.key);

const LEGACY_INDEX = Object.freeze(Object.fromEntries(MODULE_LIST.map((m) => [m.legacyDbId, m.key])));

/**
 * 注册一个界面自定义模块（管理员在「新建模块」面板创建，定义持久化在 settings）。
 *
 * 已注册过（服务重启后从 settings 重放）时直接返回现有条目，幂等。
 * legacyDbId 取模块 key 自身：前端 initModule 靠 dbId 判断联机路径，
 * 自定义模块没有历史 dbId，用 key 占位才能走上与内置模块完全相同的取数链路。
 */
export function registerCustomModule(def) {
  if (MODULES[def.key]) return MODULES[def.key];
  const entry = Object.freeze({
    ...def,
    legacyDbId: def.key,
    fieldMap: Object.freeze(Object.fromEntries(def.fields.map((f) => [f.name, f]))),
  });
  MODULES[def.key] = entry;
  MODULE_KEYS.push(def.key);
  return entry;
}

/** 注销自定义模块（仅限无数据的空模块；有数据时调用方应拒绝） */
export function unregisterCustomModule(key) {
  if (!MODULES[key]) return false;
  delete MODULES[key];
  const i = MODULE_KEYS.indexOf(key);
  if (i >= 0) MODULE_KEYS.splice(i, 1);
  return true;
}

/** 同时接受模块 key 与历史 dbId，返回模块定义或 null */
export function resolveModule(idOrKey) {
  if (!idOrKey) return null;
  const key = String(idOrKey);
  return MODULES[key] || MODULES[LEGACY_INDEX[key]] || null;
}

/** 前端 db.getSchema 需要的形状 */
export function schemaOf(mod) {
  return {
    databaseId: mod.key,
    name: mod.name,
    properties: mod.fields.map((f) => ({
      name: f.name,
      type: f.type,
      config: f.type === 'select' ? { options: f.options.slice() } : {},
    })),
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

/**
 * 期间字符串是否是真实存在的年月。
 * 单靠 /^\d{4}-\d{2}$/ 会放过 2026-13、2026-00 这种值——它们能一路写进 settings
 * 成为「当前会计期间」，也能被拼成 2026-13-01 存进日期字段。
 */
export function validMonth(value) {
  const s = String(value || '');
  if (!MONTH_RE.test(s)) return false;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  return y >= 1900 && y <= 2999 && m >= 1 && m <= 12;
}

/**
 * 日期字符串是否是真实存在的一天。
 * Date.parse('2026-02-31') 不会失败（会滚到 3 月 3 日），所以必须回读三个分量比对。
 */
export function validDate(value) {
  const s = String(value || '');
  if (!DATE_RE.test(s)) return false;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1900 || y > 2999 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * 把前端传来的 properties（WorkBuddy 形状 { 字段: {text|number|date|select: v} }
 * 或直接的扁平对象）规范化为扁平记录，并按 schema 校验类型。
 * 未在 schema 中声明的字段一律丢弃，防止污染台账。
 */
export function normalizeProperties(mod, properties, { partial = true } = {}) {
  const out = {};
  const errors = [];
  const unknown = [];
  if (!properties || typeof properties !== 'object') {
    return { data: out, errors: ['properties 必须是对象'], unknown };
  }

  for (const [rawName, rawValue] of Object.entries(properties)) {
    const field = mod.fieldMap[rawName];
    if (!field) {
      unknown.push(rawName);
      continue;
    }
    let value = rawValue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      // { text: 'x' } / { number: 1 } / { date: '2026-01-01' } / { select: 'x' }
      if ('text' in value) value = value.text;
      else if ('number' in value) value = value.number;
      else if ('date' in value) value = value.date;
      else if ('select' in value) value = value.select && typeof value.select === 'object' ? value.select.text : value.select;
      else {
        errors.push(`字段「${rawName}」的值格式无法识别`);
        continue;
      }
    }
    if (value === null || value === undefined || value === '') {
      out[field.name] = field.type === 'number' ? null : '';
      continue;
    }

    if (field.type === 'number') {
      const n = typeof value === 'number' ? value : Number(String(value).replace(/[,\s]/g, ''));
      if (!Number.isFinite(n)) {
        errors.push(`字段「${field.name}」必须是数字`);
        continue;
      }
      out[field.name] = n;
    } else if (field.type === 'date') {
      const raw = String(value);
      const s = raw.slice(0, 10);
      if (MONTH_RE.test(raw)) {
        if (!validMonth(raw)) {
          errors.push(`字段「${field.name}」的月份不存在：${raw}`);
          continue;
        }
        out[field.name] = `${raw}-01`;
      } else if (validDate(s)) {
        out[field.name] = s;
      } else {
        errors.push(`字段「${field.name}」必须是真实存在的 YYYY-MM-DD 日期`);
        continue;
      }
    } else if (field.type === 'select') {
      const s = String(value);
      if (!field.options.includes(s)) {
        errors.push(`字段「${field.name}」只能取：${field.options.join(' / ')}`);
        continue;
      }
      out[field.name] = s;
    } else {
      // 受控字段（单位/项目名称）必须用与清单校验完全相同的规范化结果落库，
      // 否则「校验用规范名、存储用原始名」会让计提链条静默断裂。详见 lib/names.js。
      const s = CONTROLLED_NAME_FIELDS.includes(field.name) ? normalizeName(value) : String(value);
      if (s.length > 500) {
        errors.push(`字段「${field.name}」长度不能超过 500 字`);
        continue;
      }
      if (CONTROLLED_NAME_FIELDS.includes(field.name) && nameTooLong(s)) {
        errors.push(`字段「${field.name}」不能超过 ${NAME_MAX} 个字`);
        continue;
      }
      out[field.name] = s;
    }
  }

  if (!partial) {
    // 新增时至少要有「单位」以外的一个业务字段，避免落空行
    const filled = Object.values(out).filter((v) => v !== '' && v !== null).length;
    if (filled === 0) errors.push('没有任何有效字段，拒绝写入空记录');
  }

  return { data: out, errors, unknown };
}

/** 记录归属的会计期间 YYYY-MM；无期间字段的模块返回 null */
export function periodOf(mod, data) {
  if (!mod.periodField) return null;
  const raw = data ? data[mod.periodField] : '';
  const s = String(raw || '').slice(0, 7);
  return validMonth(s) ? s : null;
}
