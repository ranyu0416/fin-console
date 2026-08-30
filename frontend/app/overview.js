import { $ } from './core/dom.js';
import { FIN_STORE, finApi, finServer } from './core/env.js';
import { dateStr, fmt2, ymStr } from './core/format.js';
import { cur, setCur } from './core/state.js';
import { esc } from './core/text.js';
import { calcsOf } from './engine.js';
import { asset } from './modules/asset.js';
import { baddebt } from './modules/baddebt.js';
import { lvc } from './modules/lvc.js';
import { MODULES } from './modules/registry.js';
import { levy } from './modules/levy.js';
import { facility } from './modules/facility.js';
import { union } from './modules/union.js';
import { periodEnd, viewYm } from './period.js';
import { syncPeriodChips } from './periodchips.js';
import { switchModule } from './switch.js';

export function ovCacheRows(mod){
  try{ return JSON.parse(FIN_STORE.getItem(mod.cacheKey) || '[]'); }catch(e){ return []; }
}

/** 没有 KPI 口径的模块：按期间数一下本期条数，比空白有用。 */
function sumRowsForPeriod(mod, rows, ym){
  if(!mod.periodField) return rows.length;
  return rows.filter(function(r){ return dateStr(r[mod.periodField]).slice(0, 7) === ym; }).length;
}

/** 漏录条目总数（跨模块） */
function missingCount(){
  if(!ovMissing) return 0;
  return Object.keys(ovMissing).reduce(function(n, k){ return n + (ovMissing[k].count || 0); }, 0);
}

/**
 * 漏录提醒的 HTML。每个模块一条，列出前几个缺失的名称，剩下的折成「等 N 项」。
 * 按钮直接跳到该模块，用户在那里点「本月结转」就能一次补齐。
 */
function missingHtml(){
  if(!ovMissing) return '';
  var SHOW = 4;
  return Object.keys(ovMissing).map(function(k){
    var m = ovMissing[k];
    if(!m.count) return '';
    var names = m.missing.slice(0, SHOW).map(function(it){
      return it.project ? it.unit + '·' + it.project : it.unit;
    }).join('、');
    if(m.count > SHOW) names += ' 等 ' + m.count + ' 项';
    return '<div class="attention-item warn">' +
      '<span class="tag">本期漏录</span>' +
      '<span class="txt"><b style="margin-right:6px">' + esc(m.moduleName || k) + '</b>' +
      esc(m.from) + ' 有、' + esc(m.to) + ' 还没录：' + esc(names) +
      '<br><span style="opacity:.75">进入该模块用「本月结转」可一次补齐名册</span></span>' +
      '<button class="btn btn-sm" data-goto="' + esc(k) + '">前往补录</button></div>';
  }).join('');
}

/*
 * 服务端汇总（条数、涉及单位数、最后更新时间）。
 *
 * 金额类 KPI 仍然用本地缓存算：摊销/折旧/账龄的口径要按启用日期、残值率、
 * 上期累计逐条推算，这套算法目前只在前端有。但「一共几条、最近谁改的」
 * 这类事实必须来自服务端，否则本机没缓存时总览页会显示成一片空白，
 * 让人误以为账套是空的——这是本次改动前的实际表现。
 *
 * 对应的服务端改动：/api/overview 默认只返回汇总（几百字节），
 * 不再把 6 个模块的全部明细一次性推下来（300 条就是 98.8 KB 且随数据量线性增长）。
 */
var ovSummaries = null;
/* 服务端算出的漏录情况：{ 模块key: {from, to, count, missing:[{unit, project}]} } */
var ovMissing = null;

export function renderOverview(){
  var pe = periodEnd(), ym = ymStr(pe);
  var cachedOnly = !ovSummaries;
  $('#ovPeriod').textContent = cachedOnly
    ? '　数据期间 ' + ym + '（本机缓存快照，进入各模块自动同步最新）'
    : '　数据期间 ' + ym + '（条数取自服务器，金额按本机缓存试算，进入各模块可见最新明细）';
  var kpi = {
    facility:     { label: '本月摊销', fn: function(rows, calcs){ var s = 0; rows.forEach(function(r){ var c = calcs[r._id]; if(c) s += c.curAmt || 0; }); return s; } },
    levy:  { label: '本期计提', fn: function(rows, calcs){ var s = 0; rows.forEach(function(r){ if(dateStr(r['会计期间']).slice(0, 7) !== ym) return; var c = calcs[r._id]; if(c) s += c.curAmt || 0; }); return s; } },
    union:   { label: '本期计提', fn: function(rows, calcs){ var s = 0; rows.forEach(function(r){ if(dateStr(r['会计期间']).slice(0, 7) !== ym) return; var c = calcs[r._id]; if(c) s += (c.uCur || 0) + (c.eCur || 0); }); return s; } },
    asset:   { label: '本月折旧', fn: function(rows, calcs){ var s = 0; rows.forEach(function(r){ var c = calcs[r._id]; if(c) s += c.curAmt || 0; }); return s; } },
    baddebt: { label: '本期调整', fn: function(rows, calcs){ var s = 0; rows.forEach(function(r){ var c = calcs[r._id]; if(c) s += c.cur || 0; }); return s; } },
    lvc:     { label: '本期摊销', fn: function(rows, calcs){ var s = 0; rows.forEach(function(r){ if(dateStr(r['入账月份']).slice(0, 7) !== ym) return; var c = calcs[r._id]; if(c) s += c.curAmt || 0; }); return s; } }
  };
  var cards = [], todos = [];
  Object.keys(MODULES).forEach(function(k){
    var mod = MODULES[k];
    var rows = ovCacheRows(mod);
    rows.forEach(function(r, i){ if(!r._id) r._id = k + '_row_' + i; });
    var keep = cur, calcs = {};
    setCur(mod);
    try{ calcs = calcsOf(rows); }catch(e){}
    setCur(keep);
    var def = kpi[k];
    var val = def && rows.length ? def.fn(rows, calcs) : null;
    /*
     * 没有专属 KPI 口径的模块（新增模块默认如此）：标题退回「记录数」而不是空白，
     * 数值给条数。原来这里是 def ? def.label : ''，新模块的卡片会显示成
     * 「资金管理 · 」加一个破折号——看着像坏了，其实只是没配 KPI。
     */
    var label = def ? def.label : '本期记录数';
    /* fmt2() 自带 ¥，外面不能再拼一个——原来是 '¥ ' + fmt2(val)，显示成「¥ ¥86,703.34」 */
    var display = def
      ? (val == null ? '—' : fmt2(val))
      : String(sumRowsForPeriod(mod, rows, ym));
    var sum = ovSummaries && ovSummaries[k];
    // 服务端条数与本机缓存条数不一致时明确标出来，别让用户拿旧快照当账实
    var foot = '进入' + esc(mod.entity) + '台账 →';
    var note = '';
    if(sum){
      note = '<div class="sub">服务器 ' + sum.total + ' 条';
      if(sum.total !== rows.length) note += '，本机缓存 ' + rows.length + ' 条（点进去同步）';
      note += '</div>';
    }
    cards.push('<div class="stat"><div class="label">' + esc(mod.name) + ' · ' + label + '</div>' +
      '<div class="value">' + display + '</div>' + note +
      '<div class="go" data-goto="' + k + '">' + foot + '</div></div>');
    if(mod.attention){
      var its = [];
      try{ its = mod.attention.call(mod, rows, calcs) || []; }catch(e){}
      its.forEach(function(it){
        todos.push({ mod: k, name: mod.name, level: it.level, text: it.text });
      });
    }
  });
  $('#ovStats').innerHTML = cards.join('');
  /*
   * 漏录提醒排在到期提醒前面。
   *
   * 到期提醒是「有一条记录该处理了」，漏录是「有一条记录根本不存在」。
   * 后者更危险：账面上每一条都对，只有拿总数跟上期比才能发现少提了，
   * 而月结时没人会去比。所以它必须是打开系统第一眼就看见的东西。
   */
  var missHtml = missingHtml();
  var totalTodos = todos.length + missingCount();
  var TAGS = { over: '逾期处理', warn: '即将到期', check: '勾稽异常' };
  $('#ovTodos').innerHTML = (totalTodos
    ? '<div class="card" style="padding:0;border:none;margin-bottom:0"><h2 style="padding:10px 4px 0">今天要处理（全部模块共 ' + totalTodos + ' 项）</h2>' +
      missHtml +
      todos.map(function(t){
        return '<div class="attention-item' + (t.level === 'warn' ? ' warn' : '') + '">' +
          '<span class="tag">' + (TAGS[t.level] || '提醒') + '</span>' +
          '<span class="txt"><b style="margin-right:6px">' + esc(t.name) + '</b>' + esc(t.text) + '</span>' +
          '<button class="btn btn-sm" data-goto="' + t.mod + '">前往处理</button></div>';
      }).join('') + '</div>'
    : '<div class="ov-empty">各模块均无到期提醒，本期名册也没有漏录</div>');
  /*
   * 只在本次刚重建的两个容器内绑定。
   * 原来是 document.querySelectorAll('[data-goto]')，每次重绘都会给容器外的
   * 同类元素再加一个监听器——总览刷新 N 次，点一下就跳 N 次 switchModule。
   */
  [$('#ovStats'), $('#ovTodos')].forEach(function(box){
    if(!box) return;
    Array.prototype.forEach.call(box.querySelectorAll('[data-goto]'), function(b){
      b.addEventListener('click', function(){ switchModule(b.getAttribute('data-goto')); });
    });
  });
  syncPeriodChips();
}

/** 拉一次服务端汇总再重绘。只在进入总览页时调用，响应只有几百字节。 */
export function loadOverviewSummaries(){
  if(!finServer()){ renderOverview(); return; }
  finApi('/api/overview')
    .then(function(out){
      ovSummaries = out && out.summaries ? out.summaries : null;
      ovMissing = out && out.missing ? out.missing : null;
      renderOverview();
    })
    .catch(function(err){
      console.error('[overview] 汇总加载失败:', err);
      ovSummaries = null;
      ovMissing = null;
      renderOverview();   // 拿不到汇总就退回纯缓存视图，页面仍然可用
    });
}
