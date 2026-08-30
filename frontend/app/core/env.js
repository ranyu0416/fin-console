/** 运行环境接线：存储替身、权限判定、受控清单，均由 bridge.js 在加载本模块前注入。 */

/** 共享存储：服务器模式下是 bridge.js 的替身，本地回退到 localStorage */
export const FIN_STORE = window.__FIN_STORAGE__ || window.localStorage;

/** 能力判定：未注入时（离线打开）默认全部放开 */
export function finCan(cap) {
  return !window.__FIN_CAN__ || !!window.__FIN_CAN__[cap];
}

/** 是否处于服务器模式 */
export function finServer() {
  return !!window.__FIN_SERVER__;
}

/** 服务端数据接口（bridge.js 安装） */
export const db = (window.__SMART_PAGE__ && window.__SMART_PAGE__.database)
  ? window.__SMART_PAGE__.database
  : null;

/** 调用服务端 API（bridge.js 安装）。离线打开时直接拒绝。 */
export function finApi(path, opts) {
  if (typeof window.__FIN_API__ !== 'function') {
    return Promise.reject(new Error('当前为离线模式，无法访问服务器'));
  }
  return window.__FIN_API__(path, opts);
}

/**
 * 受控清单快照：{ strict, units:[{name,...}], projects:[{unit,name,rate,...}] }。
 * 由 bridge.js 登录后注入、变更后刷新；离线打开时退化为空清单且不强制。
 */
export function finMaster() {
  return window.__FIN_MASTER__ || { strict: false, units: [], projects: [], carryModules: [] };
}

/** 重新拉取受控清单 */
export function reloadMaster() {
  if (typeof window.__FIN_RELOAD_MASTER__ !== 'function') return Promise.resolve(finMaster());
  return window.__FIN_RELOAD_MASTER__();
}

/** 在用单位名称列表 */
export function masterUnits() {
  return finMaster().units
    .filter(function (u) { return u.active !== false; })
    .map(function (u) { return u.name; });
}

/** 某单位下的在用项目；不传单位则返回全部 */
export function masterProjects(unit) {
  return finMaster().projects.filter(function (p) {
    if (p.active === false) return false;
    return unit ? p.unit === unit : true;
  });
}

/**
 * 清单是否强制。强制时录入界面用下拉框而不是文本框——
 * 「单位|项目名称」是计提链条的匹配键，错一个字链条就断，
 * 上期基数丢失会让本期计提金额静默翻倍。
 */
export function masterStrict() {
  return finMaster().strict !== false;
}
