/**
 * 通用模块工厂：把一份「字段声明」变成一个可用的台账模块。
 *
 * 为什么要有它：六个既有模块每个都有自己的计提口径（摊销、折旧、账龄、链式计提），
 * 所以它们是手写的。但绝大多数新增模块只是「登记 + 汇总 + 打印」，
 * 没有跨期推算——这类模块不该为了跑起来先抄 200 行样板代码。
 *
 * makeModule() 生成的模块具备：录入表单、列表、筛选、合计、打印、Excel 导出、
 * 结账只读、受控清单联动。需要特殊口径时，在生成的文件里覆盖对应方法即可
 * （calcAll / rowCalc / columns / buildPrint 都是普通属性，直接改）。
 *
 * 字段声明形状（与 lib/schema.js 的字段名必须逐字一致）：
 *   { name: '金额(元)', type: 'number', label: '金额（元）', required: true,
 *     options: [...]（type=select 时）, placeholder: '选填' }
 */
import { $ } from '../core/dom.js';
import { amt, dateStr, fmt, r2, ymLabel } from '../core/format.js';
import { esc } from '../core/text.js';
import { fg, numInput, unitField } from '../formkit.js';
import { viewYm } from '../period.js';

/** 表单控件的 name。用序号而不是中文字段名，避免选择器里出现需要转义的字符。 */
function inputName(index) { return 'f' + index; }

function isControlledUnit(field) { return field.name === '单位'; }

/**
 * 行级勾稽提醒工厂：给「期初 + 增加 − 减少 = 期末」这类静态勾稽关系的模块用。
 *
 * 生成的模块默认没有任何提醒，数字对不上只有靠人眼逐行核对。
 * 银行资金 / 材料收发存 / 保证金这类模块的行内勾稽关系是死的，
 * 与其在每个模块里各抄一遍，不如把「按当前期间逐行验一次」做成工厂。
 *
 * cfg:
 *   periodField  按期记录的模块只查当前视图期间；传 null 表示常设台账全量查
 *   entity       拼行身份用的字段（文案里显示「「××」2026-08 …」）
 *   parts        勾稽项 [{ field, sign }]，期望值 = Σ sign×数值
 *   close        期末字段
 *   label        异常摘要
 *   skip         可选 (row) => boolean，跳过无法判断的行（如往来单位的「平」方向）
 */
export function flowCheckAttention(cfg) {
  return function (rows) {
    var ym = viewYm();
    var items = [];
    rows.forEach(function (r) {
      if (cfg.periodField && dateStr(r[cfg.periodField]).slice(0, 7) !== ym) return;
      if (cfg.skip && cfg.skip(r)) return;
      var touched = !cfg.parts.every(function (p) { return !Number.isFinite(Number(r[p.field])); }) ||
        Number.isFinite(Number(r[cfg.close]));
      if (!touched) return;   // 该行勾稽字段全空，无从判断也不该打扰
      var expect = 0;
      cfg.parts.forEach(function (p) { expect += (Number(r[p.field]) || 0) * p.sign; });
      expect = Math.round(expect * 100) / 100;
      var close = Math.round((Number(r[cfg.close]) || 0) * 100) / 100;
      if (Math.abs(expect - close) <= 0.01) return;
      var who = cfg.entity.map(function (f) { return String(r[f] || ''); }).filter(Boolean).join(' · ');
      items.push({
        row: r, level: 'check', action: null,
        text: (who ? '「' + who + '」' : '') + (cfg.periodField ? ym + ' ' : '') +
          cfg.label + '：应为 ' + amt(expect) + '，实为 ' + amt(close) + '（差 ' + amt(close - expect) + '）',
      });
    });
    /* 同类问题太多时只摆前几条，剩下的并成一条，避免提醒区被刷屏 */
    if (items.length > 6) {
      var rest = items.length - 6;
      items = items.slice(0, 6);
      items.push({ row: null, level: 'check', action: null, text: '另有 ' + rest + ' 条勾稽不符，未逐条列出' });
    }
    return items;
  };
}

export function makeModule(def) {
  var key = def.key;
  var fields = (def.fields || []).map(function (f, i) {
    return {
      name: f.name,
      type: f.type || 'text',
      label: f.label || f.name,
      required: !!f.required,
      options: f.options || null,
      placeholder: f.placeholder || '',
      inName: inputName(i),
      /* 期间字段用 <input type="month">，落库补成当月 1 号，与服务端 schema 的处理一致 */
      isPeriod: def.periodField ? f.name === def.periodField : false,
    };
  });

  var numericFields = fields.filter(function (f) { return f.type === 'number'; });
  var selectFields = fields.filter(function (f) { return f.type === 'select' && f.options; });
  var textFields = fields.filter(function (f) { return f.type === 'text'; });

  var defaultOptions = {};
  selectFields.forEach(function (f) { defaultOptions[f.name] = f.options.slice(); });

  function controlOf(f) {
    if (isControlledUnit(f)) return null;   // 单位交给 unitField()，走受控清单
    if (f.type === 'number') return numInput(f.inName, f.placeholder || '0.00');
    if (f.type === 'select') {
      return '<select name="' + f.inName + '" data-field="' + esc(f.name) + '"' + (f.required ? ' required' : '') + '>' +
        '<option value>请选择</option>' +
        f.options.map(function (o) { return '<option value="' + esc(o) + '">' + esc(o) + '</option>'; }).join('') +
        '</select>';
    }
    if (f.type === 'date') {
      return '<input name="' + f.inName + '" type="' + (f.isPeriod ? 'month' : 'date') + '"' + (f.required ? ' required' : '') + '>';
    }
    return '<input name="' + f.inName + '" type="text" placeholder="' + esc(f.placeholder || (f.required ? '' : '选填')) + '"' +
      (f.required ? ' required' : '') + '>';
  }

  function readValue(f) {
    var el = $('[name="' + f.inName + '"]');
    return el ? String(el.value || '').trim() : '';
  }

  var mod = {
    key: key,
    name: def.name,
    entity: def.entity || def.name,
    cardTitle: def.cardTitle || (/台账$|表$/.test(def.name) ? def.name : def.name + '台账'),
    cardHint: def.cardHint || '',
    dbId: key,
    cacheKey: 'wb_fin_' + key + '_cache',
    formCacheKey: 'wb_fin_' + key + '_form',
    sortField: def.sortField || (def.periodField || ''),
    periodField: def.periodField || null,
    /* 有期间字段就只显示当前期间的记录，与 levy/union/lvc 的口径一致 */
    periodDisplay: !!def.periodField,
    selectFields: selectFields.map(function (f) { return f.name; }),
    defaultOptions: defaultOptions,
    filters: def.filters || [],

    searchHay: function (r) {
      /* 搜索覆盖文本与下拉字段：只搜文本会漏掉「按类别名找记录」这类高频操作 */
      return textFields.concat(selectFields).map(function (f) { return String(r[f.name] || ''); }).join(' ');
    },

    /* 无跨期推算：每行只算自己。需要链式口径的模块请在生成的文件里覆盖 calcAll。 */
    rowCalc: function () { return {}; },

    columns: [{ h: '序号', v: function (r, c, i) { return i + 1; } }].concat(
      fields.map(function (f) {
        return {
          h: f.label,
          num: f.type === 'number',
          v: function (r) {
            var v = r[f.name];
            if (f.type === 'number') return amt(v);
            if (f.type === 'date') return f.isPeriod ? ymLabel(v) : dateStr(v);
            return esc(v == null ? '' : String(v));
          },
        };
      }),
    ),

    stats: function (rows) {
      var labels = ['记录条数'];
      var values = [rows.length];
      /* 只汇总前三个金额字段：统计卡片一共四格，留一格给条数 */
      numericFields.slice(0, 3).forEach(function (f) {
        var sum = 0;
        rows.forEach(function (r) { sum += Number(r[f.name]) || 0; });
        labels.push(f.label + '合计');
        values.push(fmt(r2(sum)));
      });
      while (labels.length < 4) { labels.push(''); values.push(''); }
      return { labels: labels, values: values, sub: '' };
    },

    attention: function () { return []; },

    formHTML: function () {
      var html = '';
      fields.forEach(function (f) {
        if (isControlledUnit(f)) { html += unitField(); return; }
        html += fg(f.label + (f.required ? ' *' : ''), controlOf(f));
      });
      return html;
    },

    fillForm: function (r) {
      fields.forEach(function (f) {
        var el = $('[name="' + (isControlledUnit(f) ? 'unit' : f.inName) + '"]');
        if (!el) return;
        var v = r[f.name];
        if (f.type === 'date') el.value = f.isPeriod ? dateStr(v).slice(0, 7) : dateStr(v);
        else el.value = v == null ? '' : v;
      });
    },

    defaults: function () {
      var out = {};
      fields.forEach(function (f) {
        if (!f.isPeriod) return;
        /* 预填「查看期间」而不是今天：按今天预填会让记录落到当前筛选之外 */
        out[f.inName] = viewYm();
      });
      return out;
    },

    readForm: function () {
      var props = {};
      var missing = [];
      for (var i = 0; i < fields.length; i++) {
        var f = fields[i];
        var raw = isControlledUnit(f)
          ? (($('[name="unit"]') || {}).value || '').trim()
          : readValue(f);
        if (!raw) {
          if (f.required) missing.push(f.label);
          continue;
        }
        if (f.type === 'number') {
          var n = parseFloat(raw);
          if (isNaN(n)) return { err: '「' + f.label + '」不是有效数字' };
          props[f.name] = { number: n };
        } else if (f.type === 'date') {
          props[f.name] = { date: f.isPeriod ? raw + '-01' : raw };
        } else if (f.type === 'select') {
          props[f.name] = { select: raw };
        } else {
          props[f.name] = { text: raw };
        }
      }
      if (missing.length) return { err: '请填写：' + missing.join('、') };
      return { props: props };
    },
  };

  /*
   * 声明里的覆盖项原样带到生成的模块上（groupStats / groupBy / calcAll 等）。
   * mod 是白名单式逐项构造的，这里不补的话，声明里的覆盖会被静默丢弃——
   * 模块文件里明明写着 groupStats，页面上却永远不出现，而且没有任何报错。
   */
  ['groupBy', 'groupStats', 'calcAll', 'printGroup', 'printLandscape', 'attention'].forEach(function (k) {
    if (def[k] !== undefined) mod[k] = def[k];
  });

  /* 生成的模块不带 print/buildPrint/printAll：
     menu.js 的 printCurrent 与 xlsspec.js 的通用分支会按 columns 自动排一张表。
     要正式报表（合并表头、分组小计、盖章栏）时在生成的文件里补 buildPrint 即可。 */
  return mod;
}
