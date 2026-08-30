/**
 * 界面自定义模块：管理员在「新建模块」面板里定义模块名与字段，
 * 定义整体存进 settings（key: custom_modules），运行时注册进模块注册表。
 *
 * 设计要点：
 * - key 一经生成永不改变（records.module 列引用它），形如 custom_<随机后缀>，
 *   与内置模块的静态 key 天然不冲突；
 * - 固定自带「单位」字段（走受控清单）与「备注」字段；
 * - 按月记录的模块固定带「会计期间」字段（periodField 指向它），
 *   常设台账不带（记录归属账套期间，与固定资产同理）；
 * - 删除只在模块没有任何台账数据时允许——台账记录不搞级联删除，
 *   有数据的模块要清数据得先在模块页里清空，多一道确认。
 */
import { MODULES, MODULE_KEYS, registerCustomModule, unregisterCustomModule } from './schema.js';
import { getSetting, setSetting, countRecords } from './store.js';

const CUSTOM_KEY = 'custom_modules';
const FIELD_TYPES = ['text', 'number', 'date', 'select'];

function store() {
  const raw = getSetting(CUSTOM_KEY, []);
  return Array.isArray(raw) ? raw : [];
}

/** 服务启动时重放：把 settings 里的自定义定义逐个注册进模块注册表 */
export function loadCustomModules() {
  let n = 0;
  for (const def of store()) {
    try {
      registerCustomModule(def);
      n += 1;
    } catch (err) {
      console.error(`[custom] 自定义模块 ${def.key || '?'} 注册失败：${err.message}`);
    }
  }
  if (n) console.log(`[custom] 已加载 ${n} 个自定义模块`);
  return n;
}

function isCustomKey(key) {
  return typeof key === 'string' && key.startsWith('custom_');
}

/** 校验并规范化为可持久化的模块定义；不合法直接抛 ValidationError 风格的 Error */
export function validateCustomDef(body) {
  const name = String(body.name || '').trim();
  if (name.length < 2 || name.length > 20) throw new Error('模块名称需为 2-20 个字');
  const dup = MODULE_KEYS.some((k) => (MODULES[k].name || '') === name);
  if (dup) throw new Error(`已有名为「${name}」的模块`);

  const monthly = !!body.monthly;
  const rawFields = Array.isArray(body.fields) ? body.fields : [];
  if (rawFields.length < 1 || rawFields.length > 40) throw new Error('业务字段需为 1-40 个');

  const seen = new Set(['单位', '备注', monthly ? '会计期间' : '']);
  const fields = [{ name: '单位', type: 'text' }];
  if (monthly) fields.push({ name: '会计期间', type: 'date' });

  for (const f of rawFields) {
    const fname = String(f.name || '').trim();
    if (!fname || fname.length > 20) throw new Error('字段名需为 1-20 个字');
    if (seen.has(fname)) throw new Error(`字段「${fname}」与固定或已有字段重名`);
    const type = String(f.type || '');
    if (!FIELD_TYPES.includes(type)) throw new Error(`字段「${fname}」的类型无效`);
    let options;
    if (type === 'select') {
      options = (Array.isArray(f.options) ? f.options : []).map((o) => String(o).trim()).filter(Boolean);
      if (options.length < 1 || options.length > 30) throw new Error(`字段「${fname}」需提供 1-30 个选项`);
      if (new Set(options).size !== options.length) throw new Error(`字段「${fname}」的选项有重复`);
    }
    seen.add(fname);
    fields.push(options ? { name: fname, type, required: !!f.required, options } : { name: fname, type, required: !!f.required });
  }
  fields.push({ name: '备注', type: 'text' });

  const key = 'custom_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return {
    key,
    name,
    entity: name,
    monthly,
    periodField: monthly ? '会计期间' : null,
    sortField: monthly ? '会计期间' : null,
    fields,
  };
}

/** 创建：校验 → 持久化 → 注册（立即生效，无需重启） */
export function createCustomModule(body, actor) {
  const def = validateCustomDef(body);
  const list = store();
  list.push(def);
  setSetting(CUSTOM_KEY, list, actor);
  registerCustomModule(def);
  return def;
}

/** 删除：仅限自定义模块且没有任何台账数据 */
export function removeCustomModule(key, actor) {
  if (!isCustomKey(key) || !MODULES[key]) throw new Error('自定义模块不存在');
  if (countRecords(MODULES[key]) > 0) {
    throw new Error('该模块已有台账数据，不能删除；请先在模块页清空数据，或保留模块仅做隐藏');
  }
  const list = store().filter((d) => d.key !== key);
  setSetting(CUSTOM_KEY, list, actor);
  unregisterCustomModule(key);
  return true;
}
