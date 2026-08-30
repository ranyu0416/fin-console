import { $, setSync, statusPill, toast } from './core/dom.js';
import { FIN_STORE, db, finCan, finServer } from './core/env.js';
import { amt, dateStr, ymCn, ymStr } from './core/format.js';
import { cur, editingId, setEditingId } from './core/state.js';
import { esc } from './core/text.js';
import { normalizeNumInput } from './formkit.js';
import { MODULES } from './modules/registry.js';
import { guardUnlocked, periodEnd, periodLockedByKey, renderModClose, viewYm } from './period.js';
import { bindSelectFields, toggleTfaCostObj } from './switch.js';

/* ================= 模块引擎 ================= */
var cacheTimer = null;

/*
 * 一次拉取的最大条数，必须与服务端 FIN_MAX_ROWS 的默认值一致。
 * 服务端按 (期间, 创建时间) 升序返回，取少了丢的是最新期间——
 * 对链式计提模块（levy/union）意味着算出自洽但错误的金额，见 loadData 的注释。
 */
var MAX_ROWS = 20000;

export function curRows(){ return cur.rows || []; }
export function calcsOf(rows){
  var pe = periodEnd();
  if(cur.calcAll) return cur.calcAll(rows);
  var out = {};
  rows.forEach(function(r){ out[r._id] = cur.rowCalc(r, pe); });
  return out;
}
export function optText(field, val){
  if(val === null || val === undefined) return '';
  if(val && typeof val === 'object') val = val.text || '';
  var opts = (cur.opts && cur.opts[field] && cur.opts[field].length) ? cur.opts[field] : (cur.defaultOptions[field] || []);
  for(var i = 0; i < opts.length; i++){
    var o = opts[i];
    var oid = (typeof o === 'string') ? o : o.id;
    var otx = (typeof o === 'string') ? o : o.text;
    if(oid === val || otx === val) return otx;
  }
  return String(val);
}
export function optId(field, textOrId){
  var opts = (cur.opts && cur.opts[field] && cur.opts[field].length) ? cur.opts[field] : (cur.defaultOptions[field] || []);
  for(var i = 0; i < opts.length; i++){
    var o = opts[i];
    var oid = (typeof o === 'string') ? o : o.id;
    var otx = (typeof o === 'string') ? o : o.text;
    if(oid === textOrId || otx === textOrId) return oid;
  }
  return textOrId;
}

/* ---------- 渲染 ---------- */
export function renderAttention(rows, calcs){
  var items = cur.attention ? cur.attention.call(cur, rows, calcs) : [];
  var card = $('#attentionCard'), list = $('#attentionList');
  if(!items.length){ card.style.display = 'none'; return; }
  card.style.display = 'block';
  $('#attentionCount').textContent = items.length;
  var TAGS = { over: '逾期处理', warn: '即将到期', check: '勾稽异常' };
  list.innerHTML = items.map(function(it){
    var btn = (it.action === 'finish' && cur.finishUpdate)
      ? '<button class="btn btn-sm" data-finish="' + it.row._id + '">标记' + (cur.key === 'asset' ? '已提完' : '已摊完') + '</button>'
      : '';
    return '<div class="attention-item' + (it.level === 'warn' ? ' warn' : '') + '">' +
      '<span class="tag">' + (TAGS[it.level] || '提醒') + '</span>' +
      '<span class="txt">' + esc(it.text) + '</span>' + btn + '</div>';
  }).join('');
  var btns = list.querySelectorAll('[data-finish]');
  Array.prototype.forEach.call(btns, function(b){
    b.addEventListener('click', function(){ applyUpdate(b.getAttribute('data-finish'), cur.finishUpdate(b.getAttribute('data-finish'))); });
  });
}
export function renderStats(rows, calcs){
  var st = cur.stats.call(cur, rows, calcs);
  var labels = [$('#labCount'), $('#labCost'), $('#labAccrued'), $('#labNet')];
  var values = [$('#statCount'), $('#statCost'), $('#statAccrued'), $('#statNet')];
  function setCardValue(el, value){
    if(!el) return;
    var text = value != null ? String(value) : '';
    el.textContent = text;
    el.classList.toggle('neg', /-\s*\d/.test(text));
  }
  for(var i = 0; i < 4; i++){
    if(labels[i]) labels[i].textContent = st.labels[i] || '';
    setCardValue(values[i], st.values[i]);
  }
  var sub = $('#statMonth');
  if(sub){
    sub.textContent = st.sub || '';
    sub.classList.toggle('neg', /-\s*\d/.test(sub.textContent));
  }
}
export function renderGroupStats(vis, calcs){
  var card = $('#groupCard'), body = $('#groupBody');
  if(!cur.groupStats){ card.style.display = 'none'; return; }
  card.style.display = '';
  body.innerHTML = cur.groupStats.call(cur, vis, calcs);
}
export function rowVisible(r){
  var kw = $('#kw').value.trim();
  if(kw && cur.searchHay(r).indexOf(kw) < 0) return false;
  var unitSel = $('#fUnit').value;
  if(unitSel && String(r['单位'] || '') !== unitSel) return false;
  var ok = true;
  (cur.filters || []).forEach(function(f){
    if(!ok) return;
    var el = $('#' + f.el);
    if(el && el.value){
      var v = f.distinct ? String(r[f.field] || '') : optText(f.field, r[f.field]);
      if(v !== el.value) ok = false;
    }
  });
  return ok;
}
export function renderTable(rows, calcs){
  var cols = cur.columns.filter(function(c){ return !(c.gated && cur.online && !cur.schemaFields[c.gated]); });
  /* 屏显台账只保留决策字段；打印函数继续使用完整字段，不改变正式报表口径 */
  if(cur.key === 'facility'){
    var compactTfa = ['序号','单位','设施类别','设施名称','原值','本月摊销金额','开累摊销金额','本月末账面净值','状态'];
    cols = cols.filter(function(c){ return compactTfa.indexOf(c.h) >= 0; });
  } else if(cur.key === 'asset'){
    var compactAsset = ['序号','单位','固定资产编号','资产名称','资产类型','原值','本次折旧','开累折旧额','本项目承担折旧','账面余额','状态'];
    cols = cols.filter(function(c){ return compactAsset.indexOf(c.h) >= 0; });
  } else if(cur.key === 'lvc'){
    var compactLvc = ['序号','单位','入账月份','资产名称','数量','含税金额','本期摊销','成本对象'];
    cols = cols.filter(function(c){ return compactLvc.indexOf(c.h) >= 0; });
  } else if(cur.key === 'levy'){
    var compactSafety = ['序号','单位','项目名称','会计期间','当期产值','计提比例','本期计提金额','备注'];
    cols = cols.filter(function(c){ return compactSafety.indexOf(c.h) >= 0; });
  } else if(cur.key === 'union'){
    var compactUnion = ['序号','单位','会计期间','本期工资总额','工会本期计提','教育本期计提','备注'];
    cols = cols.filter(function(c){ return compactUnion.indexOf(c.h) >= 0; });

  }
  $('#thead').innerHTML = '<tr>' + cols.map(function(c){ return '<th>' + c.h + '</th>'; }).join('') + '<th>操作</th></tr>';
  var tb = $('#tbody');
  $('#emptyBox').style.display = rows.length ? 'none' : 'block';
  $('#emptyBox').textContent = '暂无记录，点击右上角「新增' + cur.entity + '」开始登记';
  tb.innerHTML = rows.map(function(r, i){
    var c = calcs[r._id] || {};
    var tds = cols.map(function(col){
      var html = col.v.call(cur, r, c, i);
      /* 负数红字：金额列首字符为负号/括号即标红 */
      if(col.num){
        var plain = String(html).replace(/<[^>]+>/g, '');
        if(/^[-(]\s*[\d(]/.test(plain)) html = '<span class="neg">' + html + '</span>';
      }
      return '<td data-label="' + col.h + '"' + (col.num ? ' class="num"' : '') + '>' + html + '</td>';
    }).join('');
    return '<tr>' + tds +
      '<td data-label="操作"><div class="row-actions">' +
        (cur.rowActions ? cur.rowActions.call(cur, r, c, i)
          : (cur.voucher ? '<button class="btn btn-sm" data-voucher="' + r._id + '">明细</button>' : '') +
            '<button class="btn btn-sm" data-edit="' + r._id + '">编辑</button>' +
            '<button class="btn btn-sm btn-danger" data-del="' + r._id + '">删除</button>') +
      '</div></td></tr>';
  }).join('');
  Array.prototype.forEach.call(tb.querySelectorAll('[data-edit]'), function(b){
    b.addEventListener('click', function(){ openModal(b.getAttribute('data-edit')); });
  });
  Array.prototype.forEach.call(tb.querySelectorAll('[data-del]'), function(b){
    b.addEventListener('click', function(){ delRecord(b.getAttribute('data-del')); });
  });
  Array.prototype.forEach.call(tb.querySelectorAll('[data-voucher]'), function(b){
    b.addEventListener('click', function(){ cur.voucher(b.getAttribute('data-voucher')); });
  });
  Array.prototype.forEach.call(tb.querySelectorAll('[data-pa]'), function(b){
    b.addEventListener('click', function(){
      if(cur.periodAction) cur.periodAction.call(cur, b.getAttribute('data-pa'), b.getAttribute('data-id'));
    });
  });
}
export function displayRows(rows){
  var vis = rows.filter(rowVisible);
  if(!cur || !cur.periodDisplay) return vis;
  var want = ymStr(periodEnd());
  var field = cur.periodField || '会计期间';
  return vis.filter(function(r){ return dateStr(r[field]).slice(0, 7) === want; });
}
export function renderModuleHint(){
  if(!cur || !$('#cardHint')) return;
  var hint = cur.cardHint || '';
  if(cur.periodDisplay){
    hint = '屏显仅当前期间：' + ymCn(periodEnd());
    /*
     * 本期间一条都没有但全量有数据时，必须说清楚——否则用户看到空表，
     * 分不清是「这个月还没录」还是「数据丢了」或「加载失败了」。
     */
    var visCount = displayRows(cur.rows || []).length;
    if((cur.rows || []).length > 0 && visCount === 0){
      hint = '当前期间（' + ymStr(periodEnd()) + '）暂无记录；全量共 ' + cur.rows.length +
             ' 条在其他期间——请切换查看期间，或用「导出/打印」取全量';
    }
  } else if(cur.key === 'facility' || cur.key === 'asset'){
    hint = '屏显保留全量资产，本期摊销/折旧按所选期间计算';
  } else if(cur.key === 'baddebt'){
    hint = '账龄与比例截至 ' + ymCn(periodEnd()) + ' 计算；本期调整额可为负数（冲回）';
  }
  $('#cardHint').textContent = hint;
}

/* ---------- 加载失败：可见提示 + 自动重试 ---------- */
var retryTimer = null;
function renderLoadFailRow(){
  var tb = document.querySelector('#tbody');
  if(!tb) return;
  var tr = document.createElement('tr');
  tr.setAttribute('data-loadfail', '1');
  tr.innerHTML = '<td colspan="12" style="text-align:center;padding:26px 0;color:#b4550a;">' +
    '数据加载失败——服务器暂时无响应或正在重启。<a href="javascript:void(0)" data-retry="1" ' +
    'style="color:var(--primary);text-decoration:underline;font-weight:600;">点击重试</a>，稍候也会自动重试</td>';
  tb.appendChild(tr);
}
function scheduleLoadRetry(forKey){
  if(retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(function(){
    retryTimer = null;
    if(cur && cur.key === forKey && cur.loadFailed && cur.online) loadData();
  }, 2500);
}
export function renderAll(){
  var rows = curRows();
  /*
   * 数据不完整时拒绝计算，而不是算出一个看起来正常的错数字。
   *
   * 链式计提（levy/union）按「单位|项目名称」把历史逐期串起来算差额，
   * 少了任何一段都仍然能算出一个自洽的结果——错，但没有任何迹象表明它错。
   * 台账的价值就在于金额可信，所以这里宁可什么都不显示。
   */
  if(cur && cur.truncated){
    renderTruncated(rows);
    return;
  }
  var calcs = calcsOf(rows);
  var vis = displayRows(rows);
  applyPeriodLock();
  renderModuleHint();
  renderAttention(rows, calcs);
  renderStats(vis, calcs);
  renderGroupStats(vis, calcs);
  renderTable(vis, calcs);
  renderModClose();
}

/** 数据没取全：清空表格与合计，把原因和处置办法直接写在界面上。 */
function renderTruncated(rows){
  var total = (cur && cur.serverTotal) || 0;
  var got = rows.length;
  if($('#thead')) $('#thead').innerHTML = '';
  if($('#tbody')) $('#tbody').innerHTML = '';
  /* 统计卡片是固定的 DOM 节点（labXxx/statXxx），只能置空文本，不能清 innerHTML */
  ['#labCount', '#labCost', '#labAccrued', '#labNet', '#statMonth'].forEach(function(sel){
    if($(sel)) $(sel).textContent = '';
  });
  ['#statCount', '#statCost', '#statAccrued', '#statNet'].forEach(function(sel){
    if($(sel)){ $(sel).textContent = '—'; $(sel).classList.remove('neg'); }
  });
  if($('#groupCard')) $('#groupCard').style.display = 'none';
  var box = $('#emptyBox');
  if(box){
    box.style.display = 'block';
    box.innerHTML = '<strong>数据未取全，已停止计算。</strong><br>' +
      '服务器共 ' + total + ' 条，本次只取到 ' + got + ' 条。' +
      '本模块的计提依赖完整的历史链条，用残缺数据计算会得出错误金额，因此这里不显示任何数字。<br>' +
      '请联系管理员调高 FIN_MAX_ROWS，或按期间/单位筛选后再查看。';
  }
  if($('#cardHint')) $('#cardHint').textContent = '数据不完整（' + got + '/' + total + '），已停止计算';
  applyPeriodLock();
  renderModClose();
}
/* 当前期间已结账 → 置顶只读提示并禁用新增/编辑/删除按钮 */
export function applyPeriodLock(){
  var locked = periodLockedByKey(cur && cur.key) || !finCan('write') || !!(cur && cur.loadFailed);
  var addBtn = $('#btnAdd');
  if(addBtn) addBtn.disabled = !!locked;
  var tbody = $('#tbody'); if(tbody) tbody.classList.toggle('locked', !!locked);
}

/* ---------- 数据 ---------- */
export function saveCache(){
  try{ FIN_STORE.setItem(cur.cacheKey, JSON.stringify(cur.rows || [])); }catch(e){}
}
export function loadCache(){
  try{
    var raw = FIN_STORE.getItem(cur.cacheKey);
    return raw ? JSON.parse(raw) : [];
  }catch(e){ return []; }
}
export function flattenProps(properties){
  var out = {};
  Object.keys(properties).forEach(function(k){
    var v = properties[k];
    out[k] = v.text !== undefined ? v.text : (v.number !== undefined ? v.number : (v.date !== undefined ? v.date : optText(k, v.select)));
  });
  return out;
}
/*
 * 请求代次。每次发起加载就 +1，回调只有在自己仍是最新一次时才允许写状态。
 *
 * 没有这个的后果：用户快速点「设施 → 固定资产」，两个请求并发，
 * 先发的设施请求后返回，就会把它的 rows 写进已经切到固定资产的 cur 上，
 * 表格显示的是固定资产的列头配上设施的数据。切得越快越容易撞上。
 */
var loadSeq = 0;

export function loadData(){
  if(!cur.online){
    cur.rows = loadCache();
    setSync('offline');
    renderAll();
    buildFilterSelects();
    return;
  }
  if(!db){
    // bridge.js 没装上数据接口（离线打开单文件版）。早点说清楚，
    // 否则后面 db.query 抛 TypeError，用户只能看到「数据加载失败」这种没信息量的提示。
    console.error('[database] 未注入服务端接口，无法联机加载');
    cur.loadFailed = true;
    cur.rows = loadCache();
    setSync('offline');
    renderAll();
    buildFilterSelects();
    return;
  }
  setSync('syncing');
  var seq = ++loadSeq;
  var forKey = cur.key;          // 记下这次请求是替哪个模块发的
  /*
   * pageSize 是服务端的 limit。sorts 传了但 bridge.js 并不会发出去——
   * 服务端固定按 (期间, 创建时间) 升序返回，这个顺序对所有模块都是想要的结果，
   * 各模块自己需要别的排法时会在渲染前再排一次（见 levy.js / union.js）。
   * 保留这个字段是为了让模块定义里的 sortField 仍然是可读的元信息，不做无效请求。
   *
   * 这个值必须与服务端上限一致（FIN_MAX_ROWS，默认 20000），不能是个更小的数。
   * 原来写 200，后果不是「只显示 200 条」这么轻：服务端按期间升序取前 200，
   * 砍掉的是**最新**的记录。而 levy/union 的计提是链式的
   * （本期计提 = 本期累计 − 上期累计），链条尾部被截掉之后，
   * 前端不知道自己拿到的是残缺数据，照样算、照样显示、照样让人打印，
   * 得到一张数字自洽但完全错误的计提表。一个模块装 20 个项目时，200 条只够 10 个月。
   */
  var q = { databaseId: cur.dbId, pageSize: MAX_ROWS };
  db.query(q)
    .then(function(result){
      if(seq !== loadSeq || !cur || cur.key !== forKey) return;   // 已被更晚的请求取代，丢弃
      cur.rows = result.results || [];
      cur.loadFailed = false;
      /*
       * 数据没取全就标记为不完整。renderAll 会据此拒绝计算并显示明确原因，
       * 而不是拿残缺的链条算出一个看起来正常的错数字。
       */
      cur.truncated = !!result.truncated;
      cur.serverTotal = result.total || cur.rows.length;
      saveCache();
      setSync(cur.truncated ? 'offline' : 'synced');
      renderAll();
      buildFilterSelects();
    })
    .catch(function(err){
      if(seq !== loadSeq || !cur || cur.key !== forKey) return;
      console.error('[database] 数据加载失败:', err);
      if(finServer()){ cur.loadFailed = true; }
      else { cur.online = false; }
      cur.rows = loadCache();
      setSync('offline');
      renderAll();
      buildFilterSelects();
      /*
       * 失败要让人看见：新模块没有本地缓存，加载失败回退后就是一张空表——
       * 用户看到的是「点进去什么都没有」，完全不知道是服务器抖了一下。
       * 表体里给出重试入口，并安排一次自动重试（服务器重启窗口通常只有几秒）。
       */
      renderLoadFailRow();
      scheduleLoadRetry(forKey);
    });
}

/**
 * 把一条服务端返回的记录并入 cur.rows，然后只重绘一次，不再整表重拉。
 *
 * 以前保存成功后调的是 loadData()，也就是「为了看到刚改的那一行，把整个模块
 * 重新下载一遍」。在 1 Mbps 的现场，200 条记录是 66 KB、约 0.5 秒纯等待，
 * 叠加整表重算与 innerHTML 重建——这就是用户说的「提交后卡一下」。
 * 服务端的 POST/PATCH 本来就返回了完整记录，直接用它更新本地即可。
 */
export function mergeRecord(rec){
  if(!rec || !rec._id || !cur) return;
  var rows = cur.rows || (cur.rows = []);
  for(var i = 0; i < rows.length; i++){
    if(rows[i]._id === rec._id){ rows[i] = rec; saveCache(); renderAll(); return; }
  }
  rows.push(rec);
  saveCache();
  renderAll();
  buildFilterSelects();   // 新增可能带来新的单位/项目，筛选下拉要跟上
}

/** 从本地移除一条记录并重绘。删除同样不需要整表重拉。 */
export function dropRecord(id){
  if(!id || !cur || !cur.rows) return;
  cur.rows = cur.rows.filter(function(r){ return r._id !== id; });
  saveCache();
  renderAll();
}
export function fillDynamicSelects(){
  Array.prototype.forEach.call(document.querySelectorAll('#formBody select'), function(sel){
    var field = sel.getAttribute('data-field');
    if(!field) return;
    var opts = (cur.opts && cur.opts[field] && cur.opts[field].length) ? cur.opts[field] : (cur.defaultOptions[field] || []);
    var keep = sel.value;
    sel.innerHTML = '<option value>请选择</option>' + opts.map(function(o){
      var oid = (typeof o === 'string') ? o : o.id;
      var otx = (typeof o === 'string') ? o : o.text;
      return '<option value="' + esc(oid) + '">' + esc(otx) + '</option>';
    }).join('');
    sel.value = keep;
  });
}
/* ---------- 筛选记忆（v2）：每个模块记住上次的筛选条件 ---------- */
export function fmKey(){ return 'fm:' + (cur ? cur.key : ''); }
export function saveFilterMemory(){
  try{
    FIN_STORE.setItem(fmKey(), JSON.stringify({
      kw: $('#kw').value, unit: $('#fUnit').value, period: viewYm(),
      cat: $('#fCat').value, status: $('#fStatus').value
    }));
  }catch(e){}
}
export function restoreFilterMemory(){
  var d = null;
  try{ d = JSON.parse(FIN_STORE.getItem(fmKey()) || 'null'); }catch(e){}
  if(!d) return;
  $('#kw').value = d.kw || '';
  $('#fUnit').value = d.unit || '';
  applySelectMemory(d);
}
export function applySelectMemory(d){
  if(!d) return;
  if(d.cat && $('#fCat').querySelector('option[value="' + d.cat + '"]')) $('#fCat').value = d.cat;
  if(d.status && $('#fStatus').querySelector('option[value="' + d.status + '"]')) $('#fStatus').value = d.status;
}
export function buildFilterSelects(){
  var rows = curRows();
  var has = { fCat: false, fStatus: false };
  (cur.filters || []).forEach(function(f){
    var el = $('#' + f.el);
    if(!el) return;
    has[f.el] = true;
    var keep = el.value;
    if(f.distinct){
      var seen = {};
      rows.forEach(function(r){ var v = String(r[f.field] || ''); if(v) seen[v] = 1; });
      el.innerHTML = '<option value>' + f.all + '</option>' + Object.keys(seen).sort().map(function(v){
        return '<option value="' + esc(v) + '">' + esc(v) + '</option>';
      }).join('');
    } else {
      var opts = (cur.opts && cur.opts[f.field] && cur.opts[f.field].length) ? cur.opts[f.field] : (cur.defaultOptions[f.field] || []);
      el.innerHTML = '<option value>' + f.all + '</option>' + opts.map(function(o){
        var otx = (typeof o === 'string') ? o : o.text;
        return '<option value="' + esc(otx) + '">' + esc(otx) + '</option>';
      }).join('');
    }
    el.value = keep;
    el.style.display = '';
  });
  if(!has.fCat) $('#fCat').style.display = 'none';
  if(!has.fStatus) $('#fStatus').style.display = 'none';
  /* 单位下拉：当前模块去重 */
  var fu = $('#fUnit'), keepUnit = fu.value;
  var useen = {};
  rows.forEach(function(r){ var v = String(r['单位'] || '').trim(); if(v) useen[v] = 1; });
  fu.innerHTML = '<option value>全部单位</option>' + Object.keys(useen).sort().map(function(v){
    return '<option value="' + esc(v) + '">' + esc(v) + '</option>';
  }).join('');
  fu.value = keepUnit;
  /*
   * 工具栏按模块自适应：没有单位数据的模块隐藏单位下拉；
   * 不按月记录的模块（如对下合同）隐藏期间选择器与本月/上月快捷 chip——
   * 留着只会让人以为它们起作用。
   */
  fu.style.display = Object.keys(useen).length ? '' : 'none';
  var showPeriod = !!cur.periodDisplay;
  var fp = $('#fPeriod');
  if(fp) fp.style.display = showPeriod ? '' : 'none';
  var chips = document.querySelector('.toolbar .period-chips');
  if(chips) chips.style.display = showPeriod ? '' : 'none';
  /* 单位输入建议（datalist）：所有模块已用单位 */
  var allUnits = {};
  Object.keys(MODULES).forEach(function(k){
    (MODULES[k].rows || []).forEach(function(r){ var v = String(r['单位'] || ''); if(v) allUnits[v] = 1; });
  });
  $('#unitOptions').innerHTML = Object.keys(allUnits).sort().map(function(v){
    return '<option value="' + esc(v) + '"></option>';
  }).join('');
  /* 选项重建后回填记忆的类别/状态 */
  var d = null;
  try{ d = JSON.parse(FIN_STORE.getItem(fmKey()) || 'null'); }catch(e){}
  applySelectMemory(d);
}

/* ---------- 弹窗 ---------- */
export function cacheForm(){
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(function(){
    try{
      var data = {};
      Array.prototype.forEach.call(document.querySelectorAll('#formBody input, #formBody select'), function(el){
        if(el.name) data[el.name] = el.value;
      });
      FIN_STORE.setItem(cur.formCacheKey, JSON.stringify(data));
    }catch(e){}
  }, 300);
}
export function restoreForm(){
  try{
    var raw = FIN_STORE.getItem(cur.formCacheKey);
    if(!raw) return;
    var d = JSON.parse(raw);
    Array.prototype.forEach.call(document.querySelectorAll('#formBody input, #formBody select'), function(el){
      if(el.name && d[el.name]) el.value = d[el.name];
    });
    if(cur.onFormInput) cur.onFormInput.call(cur);
  }catch(e){}
}
export function clearFormCache(){
  try{ FIN_STORE.removeItem(cur.formCacheKey); }catch(e){}
}
/* 自动编码：前缀-年份-三位流水（同年前缀内取最大号+1） */
export function nextCode(prefix){
  var year = new Date().getFullYear();
  var re = new RegExp('^' + prefix + '-' + year + '-(\\d+)$');
  var max = 0;
  (cur.rows || []).forEach(function(r){
    var m = String(r[cur.codeField] || '').match(re);
    if(m) max = Math.max(max, parseInt(m[1], 10));
  });
  return prefix + '-' + year + '-' + ('000' + (max + 1)).slice(-3);
}
export function openModal(id){
  if(!guardUnlocked()) return;
  setEditingId(id || null);
  $('#modalTitle').textContent = (id ? '编辑' : '新增') + cur.entity;
  $('#formBody').innerHTML = bindSelectFields(cur, cur.formHTML());
  fillDynamicSelects();
  var d = cur.defaults ? cur.defaults() : {};
  Object.keys(d).forEach(function(k){
    var el = document.querySelector('#formBody [name="' + k + '"]');
    if(el && !el.value) el.value = d[k];
  });
  if(id){
    var r = null;
    for(var i = 0; i < curRows().length; i++){ if(curRows()[i]._id === id){ r = curRows()[i]; break; } }
    if(r) cur.fillForm.call(cur, r);
  } else {
    restoreForm();
  }
  if(cur.onFormInput) cur.onFormInput.call(cur);
  if(!id && cur.autoCode){
    var codeEl = document.querySelector('#formBody [name="code"]');
    if(codeEl && !codeEl.value) codeEl.value = nextCode(cur.autoCode);
  }
  toggleTfaCostObj();
  $('#mask').className = 'mask open';
}
export function closeModal(){ $('#mask').className = 'mask'; }

/* ---------- 写操作 ---------- */
export function saveRecord(e){
  e.preventDefault();
  if(!guardUnlocked()) return;
  Array.prototype.forEach.call(document.querySelectorAll('#formBody [data-num]'), normalizeNumInput);
  var out = cur.readForm.call(cur);
  if(out.err){ toast(out.err); return; }
  var properties = out.props;
  /* 防重复录入（链式科目按唯一键校验） */
  if(cur.dupKey){
    var flatNew = flattenProps(properties);
    var nk = cur.dupKey(flatNew);
    for(var i = 0; i < cur.rows.length; i++){
      if(cur.rows[i]._id === editingId) continue;
      if(cur.dupKey(cur.rows[i]) === nk){
        toast('无法保存：' + (cur.dupHint || '已存在相同记录'));
        return;
      }
    }
  }
  var btn = $('#btnSubmit');
  btn.disabled = true; btn.textContent = '保存中...';
  if(!cur.online){
    if(editingId){
      var flat = flattenProps(properties);
      for(var j = 0; j < cur.rows.length; j++){
        if(cur.rows[j]._id === editingId){
          Object.keys(flat).forEach(function(k){ cur.rows[j][k] = flat[k]; });
          break;
        }
      }
    } else {
      var nr = flattenProps(properties);
      nr._id = 'local_' + Date.now();
      cur.rows.push(nr);
    }
    saveCache(); renderAll(); closeModal(); clearFormCache();
    btn.disabled = false; btn.textContent = '保存';
    toast('已保存到本地（离线模式）');
    return;
  }
  // 编辑时把读到的版本号一起送回去：服务端比对不上就返回 409，
  // 而不是默默把别人刚做的修改覆盖掉。rev 从当前行快照里取。
  var rev = null;
  if(editingId){
    for(var k = 0; k < cur.rows.length; k++){
      if(cur.rows[k]._id === editingId){ rev = cur.rows[k]._rev; break; }
    }
  }
  var wasEditing = editingId;
  var req = editingId
    ? db.updateRecord({ databaseId: cur.dbId, recordId: editingId, properties: properties, rev: rev })
    : db.addRecord({ databaseId: cur.dbId, properties: properties });
  req.then(function(out){
      closeModal(); clearFormCache();
      toast(wasEditing ? '已更新' : '已新增');
      // 服务端已经返回了这条记录的最新完整内容，直接并入本地重绘即可，
      // 不用再把整个模块重新拉一遍（那是「提交后卡一下」的根源）。
      if(out && out.record) mergeRecord(out.record);
      else loadData();     // 兜底：万一服务端没回记录体，退回整表刷新
    })
    .catch(function(err){
      console.error('[database] 保存失败:', err);
      if(err && err.code === 'rev_conflict'){
        // 冲突要让用户看到对方改成什么样，否则他只会再点一次保存
        toast(err.message || '这条记录已被其他人修改，正在刷新最新数据');
        loadData();
        return;
      }
      toast(err && err.message ? err.message : '保存失败，请稍后重试');
    })
    .finally(function(){
      btn.disabled = false; btn.textContent = '保存';
    });
}
/**
 * 链式模块（levy/union）的删除影响：删除一条记录后，同链条后续期间的本期计提
 * 会按剩余记录重算——删掉的是最早一期时，整段开累会并进次月，计提额可能翻几十倍。
 * 返回 ['2026-07：¥60,000.00 → ¥1,560,000.00', ...]；非链式模块或计算失败返回 null，
 * 失败时退回通用提示，不能因为预览挂掉而拦住删除本身。
 */
function chainImpact(id){
  if(!cur || (cur.key !== 'levy' && cur.key !== 'union') || typeof cur.calcAll !== 'function') return null;
  try{
    var rows = cur.rows || [];
    var target = null;
    for(var i = 0; i < rows.length; i++){ if(rows[i]._id === id){ target = rows[i]; break; } }
    if(!target) return null;
    var unit = String(target['单位'] || '');
    var proj = cur.key === 'levy' ? String(target['项目名称'] || '') : null;
    var ym = dateStr(target['会计期间']).slice(0, 7);
    var after = rows.filter(function(r){ return r._id !== id; });
    var before = cur.calcAll(rows), post = cur.calcAll(after);
    function periodAmt(c){ return cur.key === 'union' ? (c.uCur || 0) + (c.eCur || 0) : (c.curAmt || 0); }
    var changes = [];
    rows.forEach(function(r){
      if(r._id === id) return;
      if(String(r['单位'] || '') !== unit) return;
      if(proj !== null && String(r['项目名称'] || '') !== proj) return;
      var ry = dateStr(r['会计期间']).slice(0, 7);
      if(!ry || ry <= ym) return;
      var b = before[r._id], a = post[r._id];
      if(b && a && Math.abs(periodAmt(b) - periodAmt(a)) > 0.005){
        changes.push(ry + '：' + amt(periodAmt(b)) + ' → ' + amt(periodAmt(a)));
      }
    });
    return changes;
  }catch(e){ return null; }
}

export function delRecord(id){
  if(!guardUnlocked()) return;
  var impact = chainImpact(id);
  var msg;
  if(impact && impact.length){
    msg = '确定删除这条记录吗？删除后同链条后续期间将按剩余记录重算：\n' +
      impact.slice(0, 6).join('\n') +
      (impact.length > 6 ? '\n……共 ' + impact.length + ' 个期间受影响' : '') +
      '\n删除后不可恢复。';
  } else {
    msg = '确定删除这条记录吗？链式科目删除早期月份会影响后续推算，删除后不可恢复。';
  }
  if(!confirm(msg)) return;
  if(!cur.online){
    cur.rows = cur.rows.filter(function(r){ return r._id !== id; });
    saveCache(); renderAll(); toast('已删除（离线模式）');
    return;
  }
  db.deleteRecord({ databaseId: cur.dbId, recordId: id })
    .then(function(){ toast('已删除'); dropRecord(id); })
    .catch(function(err){
      console.error('[database] 删除失败:', err);
      toast(err && err.message ? err.message : '删除失败');
      loadData();   // 删除失败时本地状态可能已经不准，这里必须回读
    });
}
export function applyUpdate(id, properties){
  if(!cur.online){
    var flat = flattenProps(properties);
    for(var i = 0; i < cur.rows.length; i++){
      if(cur.rows[i]._id === id){ Object.keys(flat).forEach(function(k){ cur.rows[i][k] = flat[k]; }); break; }
    }
    saveCache(); renderAll(); toast('已标记（离线模式）');
    return;
  }
  var rev = null;
  for(var j = 0; j < cur.rows.length; j++){
    if(cur.rows[j]._id === id){ rev = cur.rows[j]._rev; break; }
  }
  db.updateRecord({ databaseId: cur.dbId, recordId: id, properties: properties, rev: rev })
    .then(function(out){
      toast('已更新状态');
      if(out && out.record) mergeRecord(out.record);
      else loadData();
    })
    .catch(function(err){
      console.error('[database] 更新失败:', err);
      if(err && err.code === 'rev_conflict'){ toast(err.message || '记录已被其他人修改，正在刷新'); loadData(); return; }
      toast(err && err.message ? err.message : '操作失败');
    });
}

