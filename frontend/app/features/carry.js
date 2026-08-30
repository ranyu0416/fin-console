/**
 * 本月结转面板：把上一期的「单位 + 项目」名册整份复制到本期，只留新数字待填。
 *
 * 这是本系统存在的主要理由。原来每月开新期，用户要把上期的单位、项目名、
 * 计提比例从 Excel 里逐条粘过来——粘错一个字，计提链条就断，金额静默翻倍。
 * 结转直接复用上期记录里的名称与比例，用户只填这一期的一列新数字。
 */
import { $, toast } from '../core/dom.js';
import { amt } from '../core/format.js';
import { finApi, finCan, finMaster } from '../core/env.js';
import { cur } from '../core/state.js';
import { esc } from '../core/text.js';
import { MODULES } from '../modules/registry.js';
import { isPeriodClosed, viewYm, ymAdd } from '../period.js';

/*
 * 支持结转的模块，取自服务端 /api/me 的 carryModules（权威来源是 lib/carry.js
 * 的 CARRY_MODULES）。不要在这里手抄一份：抄漏了新模块就没有结转入口，
 * 而且不报错——用户只会觉得"这个模块没有结转功能"。
 * FALLBACK 仅用于离线打开单文件版时还能把面板画出来。
 */
const FALLBACK_CARRY_KEYS = ['levy', 'union'];
export function carryKeys() {
  const fromServer = (finMaster().carryModules || []).filter(function (k) { return MODULES[k]; });
  return fromServer.length ? fromServer : FALLBACK_CARRY_KEYS.filter(function (k) { return MODULES[k]; });
}

function panel(html) {
  $('#adminTitle').textContent = '本月结转';
  $('#adminBody').innerHTML = html;
  $('#adminMask').className = 'mask open';
}

function closePanel() {
  $('#adminMask').className = 'mask';
}

/** 打开结转面板。默认结转当前模块；当前模块不支持时让用户选。 */
export function openCarry() {
  if (!finCan('write')) {
    toast('只读账号不能结转');
    return;
  }
  const keys = carryKeys();
  const key = cur && keys.indexOf(cur.key) >= 0 ? cur.key : keys[0];
  // 目标期间默认取「我正在看的月份」而不是账套期间：可结转的两个模块都是按月记录的，
  // 用户点「本月结转」时想的就是屏幕上这个月。面板里的目标期间仍可改。
  const to = viewYm();
  if (isPeriodClosed(key, to)) {
    toast('「' + MODULES[key].name + '」' + to + ' 已结账，请先重开该期间再结转');
    return;
  }
  render(key, to, ymAdd(to, -1));
}

function render(modKey, to, from) {
  const modSelect =
    '<select id="carryModule">' +
    carryKeys().map(function (k) {
      return '<option value="' + k + '"' + (k === modKey ? ' selected' : '') + '>' + esc(MODULES[k].name) + '</option>';
    }).join('') +
    '</select>';

  panel(
      '<div class="adm-hint">结转会把来源期间的「单位 + 项目」名册复制到目标期间，名称与计提比例照抄，' +
      '只有本期要填的新数字留空。已经存在的记录不会重复生成；上期备注写了「已完工 / 已竣工 / 已结束 / 已关闭 / 停工」的会自动跳过（「未完工」不会误判）。</div>' +
      '<div class="adm-toolbar">' +
      '<label>模块 ' + modSelect + '</label>' +
      '<label>来源期间 <input id="carryFrom" type="month" value="' + esc(from) + '"></label>' +
      '<label>目标期间 <input id="carryTo" type="month" value="' + esc(to) + '"></label>' +
      '<button class="btn btn-sm" id="carryReload" type="button">重新预览</button>' +
      '</div>' +
      '<div id="carryBody"><div class="adm-hint">加载中…</div></div>',
  );

  $('#carryModule').addEventListener('change', reload);
  $('#carryFrom').addEventListener('change', reload);
  $('#carryTo').addEventListener('change', reload);
  $('#carryReload').addEventListener('click', reload);
  reload();

  function reload() {
    const k = $('#carryModule').value;
    const f = $('#carryFrom').value;
    const t = $('#carryTo').value;
    if (!f || !t) return;
    $('#carryBody').innerHTML = '<div class="adm-hint">加载中…</div>';
    finApi('/api/carry/' + encodeURIComponent(k) + '?from=' + encodeURIComponent(f) + '&to=' + encodeURIComponent(t))
      .then(function (out) { renderPreview(out); })
      .catch(function (err) {
        $('#carryBody').innerHTML = '<div class="adm-hint">' + esc(err.message) + '</div>';
      });
  }
}

function renderPreview(out) {
  const items = out.items || [];
  const skipped = out.skipped || [];

  const skipHtml = skipped.length
    ? '<div class="adm-hint">跳过 ' + skipped.length + ' 条：' +
      skipped.map(function (s) { return esc(s.identity + '（' + s.reason + '）'); }).join('；') +
      '</div>'
    : '';

  if (!items.length) {
    $('#carryBody').innerHTML =
      skipHtml +
      '<div class="adm-hint">' + esc(out.from) + ' 没有可结转到 ' + esc(out.to) + ' 的记录。' +
      '若上期本来就没有数据，请先在上期录入，或直接在本期新增。</div>';
    return;
  }

  const hasProject = items.some(function (it) { return it.project; });
  const inputLabel = items[0].inputLabel || '本期数字';
  /* 第二列对 levy 是项目名称，对 lvc 是「资产名称 · 规格型号」，所以叫法要跟着模块走 */
  const projectHead = out.module === 'lvc' ? '资产 · 规格' : '项目名称';
  /* 累计口径才有「不能小于上期」这条校验，当期发生数（lvc 的领用数量）没有 */
  const cumulativeHint = out.cumulative === false
    ? '这一列是本期发生数，可以比上期多也可以比上期少。'
    : '填了的会校验不能小于上期。';

  $('#carryBody').innerHTML =
    skipHtml +
    '<div class="adm-hint">共 ' + items.length + ' 条待结转。「' + esc(inputLabel) +
    '」这一列可以现在填，也可以留空、结转后再逐条录入。' + cumulativeHint + '</div>' +
    '<div class="adm-scroll"><table><thead><tr>' +
    '<th>单位</th>' + (hasProject ? '<th>' + esc(projectHead) + '</th>' : '') +
    '<th class="num">上期数值</th><th class="num">' + esc(inputLabel) + '</th>' +
    '</tr></thead><tbody>' +
    items.map(function (it) {
      return '<tr>' +
        '<td>' + esc(it.unit) + '</td>' +
        (hasProject ? '<td>' + esc(it.project) + '</td>' : '') +
        '<td class="num">' + (it.reference == null ? '—' : amt(it.reference)) + '</td>' +
        '<td class="num"><input type="text" inputmode="decimal" data-carry-id="' + esc(it.identity) +
        '" placeholder="留空稍后填" style="width:150px;text-align:right"></td>' +
        '</tr>';
    }).join('') +
    '</tbody></table></div>' +
    '<div class="adm-toolbar" style="margin-top:12px">' +
    '<button class="btn btn-primary" id="carryConfirm" type="button">确认结转 ' + items.length + ' 条</button>' +
    '<span class="adm-hint" style="margin:0">目标期间 ' + esc(out.to) + '</span>' +
    '</div>';

  $('#carryConfirm').addEventListener('click', function () {
    const values = {};
    Array.prototype.forEach.call($('#carryBody').querySelectorAll('[data-carry-id]'), function (inp) {
      const v = String(inp.value || '').replace(/[,\s，]/g, '');
      if (v) values[inp.getAttribute('data-carry-id')] = v;
    });
    const filled = Object.keys(values).length;
    const msg = '把 ' + items.length + ' 条名册结转到 ' + out.to + '？' +
      (filled ? '其中 ' + filled + ' 条已填数字。' : '本次不填数字，结转后请逐条补录。');
    if (!confirm(msg)) return;

    const btn = $('#carryConfirm');
    btn.disabled = true;
    btn.textContent = '结转中…';
    finApi('/api/carry/' + encodeURIComponent(out.module), {
      method: 'POST',
      body: { from: out.from, to: out.to, values: values },
    })
      .then(function (res) {
        toast('已结转 ' + res.inserted + ' 条到 ' + res.to);
        closePanel();
        if (window.__FIN_APP__ && window.__FIN_APP__.reload) window.__FIN_APP__.reload();
      })
      .catch(function (err) {
        toast('结转失败：' + err.message);
        btn.disabled = false;
        btn.textContent = '确认结转 ' + items.length + ' 条';
      });
  });
}
