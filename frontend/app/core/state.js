/**
 * 跨模块共享的可变状态。
 * ESM 的 import 是活绑定：读取方直接 import 变量即可看到最新值，
 * 但赋值必须走这里的 setter（import 绑定是只读的）。
 */

/** 当前模块定义对象；总览页时指向 facility 以保持工具函数可用 */
export let cur = null;
export function setCur(mod) { cur = mod; }

/** 正在编辑的记录 id，null 表示新增 */
export let editingId = null;
export function setEditingId(id) { editingId = id || null; }
