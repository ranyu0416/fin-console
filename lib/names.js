/**
 * 名称规范化 —— 独立成模块的原因是它必须被两处共用：
 *   1. lib/masterdata.js  受控清单的存储与校验；
 *   2. lib/schema.js      记录字段落库前的规范化。
 *
 * 以前只有 masterdata 做规范化，schema 直接存原始值，于是出现了一个静默事故：
 *   清单里存的是「甲公司(一部)」（半角），用户录入「甲公司（一部）」（全角）
 *   → 校验时两边都规范化，比对通过
 *   → 落库存的却是原始的全角写法
 *   → carry.js 的 identityOf() 认为这是另一个项目，计提链条断成两条，
 *     上期基数变成 0，本期产值＝全部累计额，计提金额凭空翻倍且不报错。
 * 校验用什么名字，就必须存什么名字。所以两边共用这一个函数。
 */

const NAME_MAX = 60;

/** 需要走规范化的受控字段。只有这两个字段参与计提链条的身份匹配。 */
export const CONTROLLED_NAME_FIELDS = Object.freeze(['单位', '项目名称']);

/**
 * 去首尾空白、全角空格转半角、压缩内部连续空白、全角括号转半角。
 * 注意顺序：先把全角空格换成普通空格，才能被后面的 \s+ 压缩掉。
 */
export function normalizeName(raw) {
  return String(raw ?? '')
    .replace(/\u3000/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/（/g, '(')
    .replace(/）/g, ')');
}

export function nameTooLong(name) {
  return String(name || '').length > NAME_MAX;
}

export { NAME_MAX };
