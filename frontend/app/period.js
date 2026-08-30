import { $, toast } from './core/dom.js';
import { FIN_STORE, finApi, finCan, finMaster } from './core/env.js';
import { cur } from './core/state.js';
import { renderAll } from './engine.js';
import { overviewActive } from './menu.js';
import { renderOverview } from './overview.js';
import { syncPeriodChips } from './periodchips.js';

/* ================= 会计期间模型：账套期间 + 个人视图期间 =================

   一套账（单一会计主体），「单位」只是台账行的一个维度，不按单位分账本。
   期间分两层，语义不同，不要混用：

   1) 账套期间 bookYm()  —— 全局唯一，代表「这套账推进到哪个月」。
      它决定两件事，都必须全公司一致：
        · 无期间字段的模块（设施摊销、固定资产折旧、减值准备）的记录
          归属哪一期，从而决定「结账 facility 2026-03」锁住哪些记录；
        · 本月结转的默认目标期间。
      推进它等于宣布这套账进入下个月，属于结账动作的一部分，需要结账权限。

   2) 视图期间 viewYm()  —— 每个账号一份，代表「我现在想看哪个月」。
      只影响自己的筛选默认值、报表口径、新增记录时预填的期间。
      谁都可以改自己的，包括只读账号；改了不影响任何其他人。
      没设过就跟随账套期间。

   为什么要分开：以前只有一个全局期间，于是「我想翻回上个月看一眼」这个
   完全正常的需求，实际操作是把全公司的当前期间改掉——别人正在录本月数据，
   界面会突然跳到上月。而且那个接口只校验了登录没校验权限，只读账号也能改。
   分层之后：翻月份是本地动作，推进账套是受权限保护的全局动作。

   结账仍然按 模块 × 期间 全局执行，与视图期间无关——锁是账上的事实，
   不会因为谁在看哪个月而变化。                                        */

var CLOSURE_CACHE_KEY = 'wb_fin_closures';
var BOOK_YM_KEY = 'wb_work_ym';   // 账套期间（全局共享，服务端 settings）
var VIEW_YM_KEY = 'wb_view_ym';   // 视图期间（个人偏好，服务端 user_prefs）

export function nowYm(){ var n = new Date(); return n.getFullYear() + '-' + ('0' + (n.getMonth() + 1)).slice(-2); }
export function ymAdd(s, m){ var d = new Date(+s.slice(0,4), +s.slice(5,7)-1 + m, 1); return d.getFullYear() + '-' + ('0'+(d.getMonth()+1)).slice(-2); }

/** 期间字符串是否为真实存在的年月。2026-13 这种要挡住，否则会一路传到服务端。 */
export function validYm(s){
  var v = String(s || '');
  if(!/^\d{4}-\d{2}$/.test(v)) return false;
  var y = +v.slice(0, 4), m = +v.slice(5, 7);
  return y >= 1900 && y <= 2999 && m >= 1 && m <= 12;
}

/* ---------- 账套期间（全局唯一） ---------- */
export function bookYm(){
  try{ var w = FIN_STORE.getItem(BOOK_YM_KEY); if(validYm(w)) return w; }catch(e){}
  return nowYm();
}
export function setBookYm(v){ try{ FIN_STORE.setItem(BOOK_YM_KEY, v); }catch(e){} }

/* ---------- 视图期间（个人） ---------- */
export function viewYm(){
  try{ var v = FIN_STORE.getItem(VIEW_YM_KEY); if(validYm(v)) return v; }catch(e){}
  return bookYm();   // 没设过就跟随账套期间
}
export function setViewYm(v){ try{ FIN_STORE.setItem(VIEW_YM_KEY, v); }catch(e){} }

/*
 * 这里刻意不保留旧的 workYm() / currentYm() 别名。
 * 旧名字的语义是含混的「当前期间」，而现在有两个期间且权限与影响范围完全不同：
 * 留一个含混的别名，下次改代码的人就会随手用它，然后在某个地方把
 * 「个人翻月份」接到「全局推进账套」上——那正是这次要修掉的问题。
 * 调用点必须显式选择 viewYm()（我在看哪个月）或 bookYm()（这套账推进到哪个月）。
 */

/** 视图期间的月末日期。各模块的摊销/折旧/账龄都按这个时点算。 */
export function periodEnd(){
  var ym = viewYm();
  var pp = ym.split('-');
  return new Date(+pp[0], +pp[1], 0);
}

/* ---------- 模块×期间 全局结账状态（单一账套） ---------- */
export function closureKey(modKey, ym){ return modKey + '|' + ym; }
export function closureList(){ var r=[]; try{ r = JSON.parse(FIN_STORE.getItem(CLOSURE_CACHE_KEY) || '[]'); }catch(e){ r=[]; } return r; }
export function saveClosureList(a){ try{ FIN_STORE.setItem(CLOSURE_CACHE_KEY, JSON.stringify(a)); }catch(e){} }
export function isPeriodClosed(modKey, ym){ return closureList().some(function(c){ return c.key === closureKey(modKey, ym); }); }
export function setPeriodClosed(modKey, ym, on){
  var a = closureList().filter(function(c){ return c.key !== closureKey(modKey, ym); });
  if(on) a.push({ key: closureKey(modKey, ym), module: modKey, period: ym, status: '已结账', _t: Date.now() });
  saveClosureList(a);
}

/**
 * 当前模块要结账/判锁的是哪一期。
 *
 * 按月记录的模块（专项费用、工会经费、低值易耗品）：记录自带「会计期间」，
 *   用户正在录的就是他当前查看的那个月，所以按视图期间判。
 * 不按月记录的模块（设施、固定资产、减值准备）：记录没有期间字段，
 *   服务端把它们一律归到账套期间，前端必须用同一个基准，否则会出现
 *   「界面显示可编辑、提交却被服务端 409 拒绝」的错位。
 */
export function lockYmOf(mod){
  if(!mod || !mod.key || mod.key === '__overview') return viewYm();
  return mod.periodField ? viewYm() : bookYm();
}

/** 当前模块 · 相应期间 是否只读（已结账） */
export function periodLockedByKey(modKey){
  if(!modKey || modKey === '__overview') return false;
  var mod = (cur && cur.key === modKey) ? cur : null;
  // 拿不到模块定义时按视图期间判：宁可少锁，服务端仍会拦住真正的越权写入
  return isPeriodClosed(modKey, mod ? lockYmOf(mod) : viewYm());
}

export function guardUnlocked(){
  if(!finCan('write')){ toast('当前账号为只读权限，不能新增或修改数据'); return false; }
  if(cur && cur.loadFailed){ toast('与服务器连接中断，暂时只读；请恢复连接后刷新页面'); return false; }
  if(!cur || !cur.key || cur.key === '__overview') return true;
  var ym = lockYmOf(cur);
  if(isPeriodClosed(cur.key, ym)){
    toast('「' + cur.name + '」' + ym + ' 已结账为只读，请先重开该期间再修改。');
    return false;
  }
  return true;
}

/* ---------- 切换视图期间（个人动作，任何账号都能做） ---------- */
export function setPeriod(ym, nav){
  if(!validYm(ym)) return;
  setViewYm(ym);
  if($('#fPeriod')) $('#fPeriod').value = ym;
  renderPeriodBar();
  syncPeriodChips();
  if($('#ovPeriod')){
    $('#ovPeriod').textContent = '　数据期间 ' + ym + '（离线缓存快照，进入各模块自动同步最新）';
  }
  refresh();
  if(nav) toast('查看期间：' + ym);
}
export function advancePeriod(delta){
  setPeriod(ymAdd(viewYm(), delta || 1), true);
}

/**
 * 推进账套期间（全局动作，需要结账权限）。
 * 与切换视图期间是两件事：这个会改变所有人看到的账套状态，
 * 也会改变不按月记录模块的归属期，所以要二次确认。
 */
export function advanceBookPeriod(ym){
  if(!finCan('close')){ toast('只有管理员或记账员可以推进账套期间'); return; }
  if(!validYm(ym)) return;
  var from = bookYm();
  if(ym === from) return;
  if(!confirm(
    '确认把账套期间从 ' + from + ' 推进到 ' + ym + '？\n\n' +
    '这会改变所有人看到的账套状态，也会改变「设施摊销 / 固定资产折旧 / 减值准备」' +
    '新记录的归属期间。只想自己换个月份查看的话，用上方的「查看期间」即可。'
  )) return;
  setBookYm(ym);
  // 推进账套后把自己的视图也跟过去，否则界面还停在旧月份，容易误判
  setViewYm(ym);
  renderPeriodBar();
  syncPeriodChips();
  refresh();
  toast('账套期间已推进到 ' + ym);
}

/* ---------- 顶栏渲染 ---------- */
export function renderPeriodBar(){
  var vym = viewYm(), bym = bookYm();
  var inp = $('#pbYm'); if(inp && inp.value !== vym) inp.value = vym;
  var moduleInp = $('#fPeriod'); if(moduleInp && moduleInp.value !== vym) moduleInp.value = vym;
  var hintEl = $('#pbHint');
  if(hintEl){
    // 视图期间与账套期间不一致时要说清楚，否则用户会以为自己在录当期数据
    var txt = '账套期间 ' + bym + ' · 已结账 ' + closureList().length + ' 个模块期间';
    if(vym !== bym) txt = '正在查看 ' + vym + '（账套期间 ' + bym + '）· 已结账 ' + closureList().length + ' 个模块期间';
    hintEl.textContent = txt;
  }
  // 没有结账权限就不显示「推进账套期间」——按了也会被服务端拒绝，
  // 摆在那里只会让只读用户反复点击并收到一串权限错误
  var bookBtn = $('#pbBook');
  if(bookBtn) bookBtn.style.display = finCan('close') ? '' : 'none';
}
export function renderPeriodList(){}   /* 已由原生月选择器取代，保留空实现以防残留调用 */

/* ---------- 每模块结账控件 ---------- */
export function renderModClose(){
  if(!cur || !cur.name || !cur.key) return;
  if(overviewActive()){ var m2 = $('#modClose'); if(m2) m2.innerHTML = ''; return; }
  var el = $('#modClose'); if(!el) return;
  if(cur.key === '__overview'){ el.innerHTML = ''; return; }
  var ym = lockYmOf(cur);
  var closed = isPeriodClosed(cur.key, ym);
  el.innerHTML =
    '<span class="mc-pill ' + (closed ? 'on' : 'off') + '"><span class="dot"></span>' +
    ym + (closed ? ' · 已结账（只读）' : ' · 处理中') + '</span>' +
    (closed
      ? '<button class="btn btn-sm" type="button" data-reopen="1">重开</button>'
      : '<button class="btn btn-sm btn-primary" type="button" data-close="1">结账</button>');
  var clo = el.querySelector('[data-close]');
  if(clo) clo.addEventListener('click', function(){ closeModulePeriod(ym); });
  var reo = el.querySelector('[data-reopen]');
  if(reo) reo.addEventListener('click', function(){ reopenModulePeriod(ym); });
}
export function closeModulePeriod(ym){
  if(!finCan('close')){ toast('当前账号没有结账权限'); return; }
  if(!guardUnlocked()) return;
  var key = cur.key, name = cur.name;
  var baseMsg = '确认结账「' + name + '」' + ym + '？结账后该模块该期间只读，可通过「重开」恢复编辑。';
  /*
   * 结账前的最后一道检查：可结转模块若本期还有上期名册没录（漏录），
   * 结账等于宣布「这个月就这么算了」——这些项目本期没有计提记录，
   * 而且此后漏录提醒不再出现（它的目标期间已经翻篇）。
   * 检查失败（网络抖动、离线）不拦结账，退回普通确认框。
   */
  if((finMaster().carryModules || []).indexOf(key) >= 0){
    finApi('/api/carry/' + encodeURIComponent(key) + '?to=' + encodeURIComponent(ym))
      .then(function(out){
        var items = (out && out.items) || [];
        var msg = baseMsg;
        if(items.length){
          var names = items.slice(0, 5).map(function(it){
            return it.project ? it.unit + '·' + it.project : it.unit;
          }).join('、');
          if(items.length > 5) names += ' 等 ' + items.length + ' 项';
          msg = '注意：' + ym + ' 还有 ' + items.length + ' 条上期名册未录入：' + names + '。\n' +
                '这些项目本期将没有计提记录，结账后也不会再提醒。\n\n' + baseMsg;
        }
        if(confirm(msg)) doCloseModulePeriod(key, name, ym);
      })
      .catch(function(){
        if(confirm(baseMsg)) doCloseModulePeriod(key, name, ym);
      });
    return;
  }
  if(confirm(baseMsg)) doCloseModulePeriod(key, name, ym);
}

function doCloseModulePeriod(key, name, ym){
  setPeriodClosed(key, ym, true);
  if($('#fPeriod') && $('#fPeriod').value) $('#fPeriod').value = '';
  renderModClose(); renderPeriodBar(); renderPeriodList();
  refresh();
  toast('已结账（只读）：' + name + ' ' + ym);
}
export function reopenModulePeriod(ym){
  if(!finCan('close')){ toast('当前账号没有重开权限'); return; }
  if(!confirm('确认重开「' + cur.name + '」' + ym + '？重开后可继续编辑该期间数据。')) return;
  setPeriodClosed(cur.key, ym, false);
  renderModClose(); renderPeriodBar(); renderPeriodList();
  refresh();
  toast('已重开：' + cur.name + ' ' + ym);
}

export function refresh(){ if(overviewActive()) renderOverview(); else renderAll(); }
