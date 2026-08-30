/* ================= 表单片段 ================= */
import { esc } from './core/text.js';
import { masterProjects, masterStrict, masterUnits } from './core/env.js';

export function fg(label, inner){ return '<div class="fgroup"><label>' + label + '</label>' + inner + '</div>'; }
export function fgRow(a, b){ return '<div class="frow">' + a + b + '</div>'; }

/**
 * 单位字段。受控清单开启时渲染成 <select>，只能选清单里的单位。
 *
 * 为什么不给自由文本：专项费用按「单位|项目名称」串联各期，工会经费按「单位」串联。
 * 名字多一个空格或写法不一致，链条就断成两条，上期累计基数丢失，
 * 本期产值被当成全部开累额，计提金额直接翻倍且不报错。
 */
export function unitField(){
  var units = masterUnits();
  /* 清单为空时退回自由文本：新装系统还没建清单，不能把人堵在门外。
     管理员添加第一个单位后，这里自动变成下拉框，服务端校验同步生效。 */
  if(!masterStrict() || !units.length){
    return fg('单位 *', '<input name="unit" type="text" list="unitOptions" placeholder="如：一分公司" required>') +
      (masterStrict()
        ? '<div class="field-warn">单位清单还是空的，暂时可以自由输入。建议管理员先在「⋯ → 单位/项目清单」里建好清单，之后录入改为下拉选择，避免名称写法不一致导致计提链条断裂。</div>'
        : '');
  }
  return fg('单位 *',
    '<select name="unit" required data-master="unit"><option value>请选择</option>' +
    units.map(function(u){ return '<option value="' + esc(u) + '">' + esc(u) + '</option>'; }).join('') +
    '</select>');
}

/**
 * 项目名称字段（专项费用用）。清单里该单位下有项目时是下拉框，
 * 选项随「单位」联动——见 refreshProjectOptions；否则退回自由文本。
 */
export function projectField(){
  if(!masterStrict() || !masterUnits().length){
    return fg('项目名称 *', '<input name="proj" type="text" placeholder="如：示例项目A" required>');
  }
  return fg('项目名称 *',
    '<select name="proj" required data-master="project"><option value>请先选择单位</option></select>');
}

/**
 * 按当前选中的单位重填项目下拉框。
 * 返回该项目在清单里登记的计提比例（没有登记则 null），供录入界面自动填充。
 * 若该单位在清单里还没有任何项目，把下拉框换成文本框——先让人能录，再逐步收口。
 */
export function refreshProjectOptions(form, keepValue){
  if(!form) return null;
  var projEl = form.querySelector('[name="proj"]');
  if(!projEl || projEl.tagName !== 'SELECT') return null;
  var unitEl = form.querySelector('[name="unit"]');
  var unit = unitEl ? unitEl.value : '';
  var list = unit ? masterProjects(unit) : [];
  var want = keepValue !== undefined ? keepValue : projEl.value;

  if(unit && !list.length){
    /* 该单位下清单为空：换成文本框并提示，保持可用 */
    var input = document.createElement('input');
    input.type = 'text';
    input.name = 'proj';
    input.required = true;
    input.placeholder = '清单里暂无该单位的项目，可直接输入';
    input.value = want || '';
    projEl.parentNode.replaceChild(input, projEl);
    return null;
  }

  projEl.innerHTML = (unit ? '<option value>请选择</option>' : '<option value>请先选择单位</option>') +
    list.map(function(p){
      return '<option value="' + esc(p.name) + '" data-rate="' + (p.rate == null ? '' : p.rate) + '">' + esc(p.name) + '</option>';
    }).join('');
  if(want && list.some(function(p){ return p.name === want; })) projEl.value = want;
  var sel = projEl.options[projEl.selectedIndex];
  var rate = sel ? sel.getAttribute('data-rate') : '';
  return rate === '' || rate === null ? null : Number(rate);
}

export function numInput(name, ph, extra){
  /* 金额/数量输入：文本框 + 数字键盘，支持全角数字与千分位逗号（自动归一） */
  return '<input name="' + name + '" type="text" inputmode="decimal" data-num placeholder="' + (ph || '0.00') + '" ' + (extra || '') + '>';
}

/* 输入归一：全角→半角、去千分位逗号与空白 */
export function normalizeNumInput(el){
  if(!el || !el.value) return;
  var v = el.value
    .replace(/[０-９]/g, function(ch){ return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); })
    .replace(/[．]/g, '.')
    .replace(/[－—－]/g, '-')
    .replace(/[，,]/g, '')
    .replace(/\s/g, '');
  if(v !== el.value) el.value = v;
}
