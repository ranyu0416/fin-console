/**
 * Excel 粘贴导入：从 Excel 里选一块单元格，直接贴进来，逐行校验后批量入库。
 *
 * 设计取舍：
 *   - 不解析 .xlsx 文件。剪贴板里的 TSV 已经够用，而且不引入任何依赖。
 *   - 先预检再写库：服务端 /import/check 返回每行的错误，用户当场改，
 *     不会出现「导了一半失败」的中间状态。
 *   - 列顺序由用户在界面上确认，不猜表头——猜错列会把金额贴到比例上。
 */
import { $, toast } from '../core/dom.js';
import { finApi, finCan } from '../core/env.js';
import { cur } from '../core/state.js';
import { esc } from '../core/text.js';
import { MODULES } from '../modules/registry.js';
import { viewYm } from '../period.js';

/**
 * 各模块可粘贴的列。name 必须与服务端 schema.js 的字段名完全一致。
 * required 只影响界面提示，真正的校验在服务端。
 */
export const PASTE_SPECS = {
  levy: {
    label: '专项费用',
    hint: '常见做法：从 Excel 里复制「单位、项目名称、累计产值、计提比例」四列。会计期间统一用下面选的期间。',
    periodField: '会计期间',
    columns: [
      { name: '单位', type: 'text', required: true },
      { name: '项目名称', type: 'text', required: true },
      { name: '累计产值(元)', type: 'number', required: true },
      { name: '计提比例(%)', type: 'number' },
      { name: '上期累计产值(元)', type: 'number' },
      { name: '期初已计提(元)', type: 'number' },
      { name: '备注', type: 'text' },
    ],
  },
  union: {
    label: '工会·职工教育经费',
    hint: '复制「单位、工资年开累」两列即可；比例留空时沿用录入界面的默认值。',
    periodField: '会计期间',
    columns: [
      { name: '单位', type: 'text', required: true },
      { name: '工资年开累(元)', type: 'number', required: true },
      { name: '工会经费比例(%)', type: 'number' },
      { name: '职工教育经费比例(%)', type: 'number' },
      { name: '上期工资年开累(元)', type: 'number' },
      { name: '工会期初已计提(元)', type: 'number' },
      { name: '教育期初已计提(元)', type: 'number' },
      { name: '备注', type: 'text' },
    ],
  },
  facility: {
    label: '设施摊销',
    hint: '一次性建账用：把台账里的设施逐行贴进来。期初已摊销与期初截止期间成对填写。',
    periodField: null,
    columns: [
      { name: '单位', type: 'text', required: true },
      { name: '设施名称', type: 'text', required: true },
      { name: '设施类别', type: 'select' },
      { name: '原值(元)', type: 'number', required: true },
      { name: '残值率(%)', type: 'number' },
      { name: '摊销期限(月)', type: 'number', required: true },
      { name: '启用日期', type: 'date', required: true },
      { name: '入账日期', type: 'date' },
      { name: '摊销方法', type: 'select' },
      { name: '状态', type: 'select' },
      { name: '成本对象', type: 'text' },
      { name: '期初已摊销(元)', type: 'number' },
      { name: '期初截止期间', type: 'date' },
      { name: '备注', type: 'text' },
    ],
  },
  asset: {
    label: '固定资产折旧',
    hint: '一次性建账用。期初已折旧与期初截止期间成对填写。',
    periodField: null,
    columns: [
      { name: '单位', type: 'text', required: true },
      { name: '资产名称', type: 'text', required: true },
      { name: '资产类型', type: 'select' },
      { name: '原值(元)', type: 'number', required: true },
      { name: '残值率(%)', type: 'number' },
      { name: '预计使用年限(年)', type: 'number', required: true },
      { name: '启用日期', type: 'date', required: true },
      { name: '转移至项目日期', type: 'date' },
      { name: '状态', type: 'select' },
      { name: '期初已折旧(元)', type: 'number' },
      { name: '期初截止期间', type: 'date' },
      { name: '备注', type: 'text' },
    ],
  },
  baddebt: {
    label: '减值准备',
    hint: '按科目/往来单位逐行贴入余额与比例。',
    periodField: null,
    columns: [
      { name: '单位', type: 'text', required: true },
      { name: '科目名称', type: 'text', required: true },
      { name: '往来单位名称', type: 'text' },
      { name: '入账日期', type: 'date', required: true },
      { name: '科目余额(元)', type: 'number', required: true },
      { name: '计提比例(%)', type: 'number' },
      { name: '已计提金额(元)', type: 'number' },
    ],
  },
  lvc: {
    label: '低值易耗品',
    hint: '按月贴入本期新领用/新入库的低值易耗品。入账月份统一用下面选的期间。',
    periodField: '入账月份',
    columns: [
      { name: '单位', type: 'text', required: true },
      { name: '资产名称', type: 'text', required: true },
      { name: '规格型号', type: 'text' },
      { name: '计量单位', type: 'text' },
      { name: '数量', type: 'number' },
      { name: '单价(元)', type: 'number' },
      { name: '凭证号', type: 'text' },
      { name: '开票日期', type: 'date' },
      { name: '可抵扣进项税额(元)', type: 'number' },
      { name: '领用人', type: 'text' },
      { name: '成本对象', type: 'text' },
    ],
  },
};

/** 数字归一：全角、千分位、括号负数、百分号 */
function toNumber(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  s = s
    .replace(/[０-９]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); })
    .replace(/[．]/g, '.')
    .replace(/[，,\s￥¥]/g, '')
    .replace(/[－—]/g, '-');
  let neg = false;
  if (/^\((.*)\)$/.test(s)) { neg = true; s = s.slice(1, -1); }   // 会计式负数 (1,234)
  if (s.endsWith('%')) s = s.slice(0, -1);
  const n = Number(s);
  if (!Number.isFinite(n)) return NaN;
  return neg ? -n : n;
}

/** 日期归一：接受 2026-03-01 / 2026/3/1 / 2026年3月 / 2026-03 */
function toDate(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})\s*[-/年.]\s*(\d{1,2})(?:\s*[-/月.]\s*(\d{1,2}))?/);
  if (!m) return NaN;
  const y = m[1];
  const mo = ('0' + m[2]).slice(-2);
  const d = ('0' + (m[3] || '1')).slice(-2);
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return NaN;
  return y + '-' + mo + '-' + d;
}

/** 把剪贴板文本切成二维数组，跳过整行空白 */
export function parseClipboard(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(function (line) { return line.split('\t'); })
    .filter(function (cells) { return cells.some(function (c) { return String(c).trim() !== ''; }); });
}

/** 看首行是不是表头：任一单元格与列名相符即认为是表头 */
function looksLikeHeader(cells, spec) {
  const names = spec.columns.map(function (c) { return c.name.replace(/\(.*?\)/g, ''); });
  return cells.some(function (c) {
    const v = String(c).trim().replace(/[（(].*?[)）]/g, '');
    return v && names.indexOf(v) >= 0;
  });
}

function panel(html) {
  $('#adminTitle').textContent = 'Excel 粘贴导入';
  $('#adminBody').innerHTML = html;
  $('#adminMask').className = 'mask open';
}

function closePanel() { $('#adminMask').className = 'mask'; }

/** 打开粘贴导入面板 */
export function openPaste() {
  if (!finCan('write')) {
    toast('只读账号不能导入数据');
    return;
  }
  const key = cur && PASTE_SPECS[cur.key] ? cur.key : 'levy';
  render(key);
}

function render(modKey) {
  const keys = Object.keys(PASTE_SPECS);
  const spec = PASTE_SPECS[modKey];

  panel(
    '<div class="adm-toolbar">' +
      '<label>模块 <select id="pasteModule">' +
      keys.map(function (k) {
        return '<option value="' + k + '"' + (k === modKey ? ' selected' : '') + '>' + esc(PASTE_SPECS[k].label) + '</option>';
      }).join('') +
      '</select></label>' +
      (spec.periodField
        ? '<label>会计期间 <input id="pastePeriod" type="month" value="' + esc(viewYm()) + '"></label>'
        : '') +
      '</div>' +
      '<div class="adm-hint" id="pasteHint">' + esc(spec.hint) + '</div>' +
      '<div class="adm-hint">粘贴顺序（多余的列会被忽略，右侧可调）：<span id="pasteMap"></span></div>' +
      '<textarea id="pasteArea" rows="8" placeholder="在 Excel 里选中数据区域，Ctrl+C，然后点这里 Ctrl+V" ' +
      'style="width:100%;font-family:ui-monospace,Consolas,monospace;font-size:12px"></textarea>' +
      '<div class="adm-toolbar">' +
      '<button class="btn btn-sm btn-primary" id="pasteCheck" type="button">校验并预览</button>' +
      '<label><input type="checkbox" id="pasteHasHeader"> 首行是表头</label>' +
      '</div>' +
      '<div id="pastePreview"></div>',
  );

  renderMap(modKey);
  $('#pasteModule').addEventListener('change', function () { render(this.value); });
  $('#pasteCheck').addEventListener('click', function () { check(modKey); });
  $('#pasteArea').addEventListener('paste', function () {
    // 粘贴后自动猜一次表头，省一次点击
    setTimeout(function () {
      const rows = parseClipboard($('#pasteArea').value);
      if (rows.length && looksLikeHeader(rows[0], PASTE_SPECS[modKey])) $('#pasteHasHeader').checked = true;
    }, 0);
  });
}

function renderMap(modKey) {
  const spec = PASTE_SPECS[modKey];
  $('#pasteMap').innerHTML = spec.columns
    .map(function (c, i) {
      return '<code>' + (i + 1) + '.' + esc(c.name) + (c.required ? ' *' : '') + '</code>';
    })
    .join(' ');
}

function buildRows(modKey) {
  const spec = PASTE_SPECS[modKey];
  const raw = parseClipboard($('#pasteArea').value);
  const skipHeader = $('#pasteHasHeader').checked;
  const cells = skipHeader ? raw.slice(1) : raw;
  const period = spec.periodField && $('#pastePeriod') ? $('#pastePeriod').value : '';

  const rows = [];
  const localErrors = [];

  cells.forEach(function (line, idx) {
    const props = {};
    let bad = null;
    spec.columns.forEach(function (col, ci) {
      const cell = line[ci];
      if (cell === undefined || String(cell).trim() === '') return;
      const v = String(cell).trim();
      if (col.type === 'number') {
        const n = toNumber(v);
        if (Number.isNaN(n)) { bad = bad || '第 ' + (ci + 1) + ' 列「' + col.name + '」不是有效数字：' + v; return; }
        if (n !== null) props[col.name] = { number: n };
      } else if (col.type === 'date') {
        const d = toDate(v);
        if (Number.isNaN(d)) { bad = bad || '第 ' + (ci + 1) + ' 列「' + col.name + '」不是有效日期：' + v; return; }
        if (d) props[col.name] = { date: d };
      } else if (col.type === 'select') {
        props[col.name] = { select: v };
      } else {
        props[col.name] = { text: v };
      }
    });
    if (spec.periodField && period) props[spec.periodField] = { date: period + '-01' };
    if (bad) localErrors.push({ index: idx, error: bad, line: line });
    rows.push(props);
  });

  return { rows: rows, localErrors: localErrors, spec: spec };
}

function check(modKey) {
  const built = buildRows(modKey);
  if (!built.rows.length) {
    $('#pastePreview').innerHTML = '<div class="adm-hint">还没有粘贴任何数据。</div>';
    return;
  }
  $('#pastePreview').innerHTML = '<div class="adm-hint">校验中…</div>';

  finApi('/api/modules/' + encodeURIComponent(modKey) + '/import/check', {
    method: 'POST',
    body: { rows: built.rows },
  })
    .then(function (out) { renderPreview(modKey, built, out); })
    .catch(function (err) {
      $('#pastePreview').innerHTML = '<div class="adm-hint">校验失败：' + esc(err.message) + '</div>';
    });
}

function renderPreview(modKey, built, out) {
  const spec = built.spec;
  const serverRows = out.rows || [];
  // 本地解析错误优先展示：这些行连字段都没解析出来
  const localByIndex = {};
  built.localErrors.forEach(function (e) { localByIndex[e.index] = e.error; });

  const problems = [];
  serverRows.forEach(function (r, i) {
    const local = localByIndex[i];
    if (local) problems.push({ index: i, errors: [local] });
    else if (!r.ok) problems.push({ index: i, errors: r.errors });
  });

  const okCount = serverRows.length - problems.length;
  const cols = spec.columns.slice(0, 6);

  let html =
    '<div class="adm-hint">共 ' + serverRows.length + ' 行：<strong>' + okCount + '</strong> 行可导入' +
    (problems.length ? '，<strong>' + problems.length + '</strong> 行有问题' : '') + '。</div>';

  if (problems.length) {
    html +=
      '<div class="adm-scroll" style="max-height:26vh"><table><thead><tr><th>行号</th><th>问题</th></tr></thead><tbody>' +
      problems.map(function (p) {
        return '<tr><td>' + (p.index + 1) + '</td><td class="detail">' + esc(p.errors.join('；')) + '</td></tr>';
      }).join('') +
      '</tbody></table></div>';
  }

  html +=
    '<div class="adm-hint">前 ' + Math.min(10, okCount) + ' 行预览：</div>' +
    '<div class="adm-scroll" style="max-height:26vh"><table><thead><tr><th>#</th>' +
    cols.map(function (c) { return '<th>' + esc(c.name) + '</th>'; }).join('') +
    '</tr></thead><tbody>' +
    serverRows
      .filter(function (r, i) { return r.ok && !localByIndex[i]; })
      .slice(0, 10)
      .map(function (r, i) {
        return '<tr><td>' + (i + 1) + '</td>' +
          cols.map(function (c) {
            const v = r.data[c.name];
            return '<td>' + esc(v == null ? '' : v) + '</td>';
          }).join('') + '</tr>';
      })
      .join('') +
    '</tbody></table></div>';

  if (okCount > 0) {
    html +=
      '<div class="adm-toolbar" style="margin-top:12px">' +
      '<button class="btn btn-primary" id="pasteConfirm" type="button">导入 ' + okCount + ' 行</button>' +
      (problems.length ? '<span class="adm-hint" style="margin:0">有问题的行会被跳过，不影响其余行。</span>' : '') +
      '</div>';
  }

  $('#pastePreview').innerHTML = html;

  const btn = $('#pasteConfirm');
  if (!btn) return;
  btn.addEventListener('click', function () {
    const good = built.rows.filter(function (_, i) {
      return serverRows[i] && serverRows[i].ok && !localByIndex[i];
    });
    if (!confirm('把 ' + good.length + ' 行导入「' + MODULES[modKey].name + '」？导入后可在台账里逐条修改。')) return;
    btn.disabled = true;
    btn.textContent = '导入中…';
    finApi('/api/modules/' + encodeURIComponent(modKey) + '/import', {
      method: 'POST',
      body: { rows: good, replace: false },
    })
      .then(function (res) {
        toast('已导入 ' + res.inserted + ' 行' + (res.skipped ? '，跳过 ' + res.skipped + ' 行' : ''));
        closePanel();
        if (window.__FIN_APP__ && window.__FIN_APP__.reload) window.__FIN_APP__.reload();
      })
      .catch(function (err) {
        toast('导入失败：' + err.message);
        btn.disabled = false;
        btn.textContent = '导入 ' + good.length + ' 行';
      });
  });
}
