#!/usr/bin/env node
/**
 * 新增模块脚手架。
 *
 * 用途：把「加一个台账模块」从「照着 6 处改代码、漏一处静默出错」
 * 变成「写一份字段声明 → 跑一条命令 → 跑测试」。
 *
 * 用法：
 *   node scripts/new-module.mjs 模块声明.json          # 生成
 *   node scripts/new-module.mjs 模块声明.json --dry-run # 只看会改哪些文件
 *   node scripts/new-module.mjs --example > 我的模块.json # 打一份声明模板
 *
 * 声明文件形状（字段名会原样落库，改名等于换字段，见 README 的字段约定）：
 * {
 *   "key": "cash",                     // 英文短名，作模块 key / 文件名 / 接口路径
 *   "name": "资金管理",                 // 页签与标题上的中文名
 *   "entity": "资金记录",               // 「新增XX」按钮里的量词
 *   "periodField": "会计期间",          // 按月记录的模块填这个字段名；不按月记录填 null
 *   "sortField": "会计期间",
 *   "fields": [
 *     { "name": "单位", "type": "text", "required": true },
 *     { "name": "会计期间", "type": "date", "required": true },
 *     { "name": "收款金额(元)", "type": "number" },
 *     { "name": "款项性质", "type": "select", "options": ["项目款", "保证金"] },
 *     { "name": "备注", "type": "text" }
 *   ]
 * }
 *
 * 它会改这些地方（每处都是新增模块必须改、漏了会静默出问题的）：
 *   1. lib/schema.js                        服务端权威字段定义（不改这里，接口一律 404）
 *   2. frontend/app/modules/<key>.js         前端模块定义（由 makeModule 生成）
 *   3. frontend/app/modules/registry.js      注册表（不改这里，页签点了没反应）
 *   4. frontend/index.html                   模块页签（不改这里，界面上根本没有入口）
 *
 * 不改的地方，以及为什么不用改：
 *   · admin.js / printconfig.js —— 已改为从服务端 schema 与 registry 读模块清单
 *   · print.js / xlsspec.js     —— 没写专属报表规格时自动按 columns 生成
 *   · lib/routes.js、lib/store.js —— 本来就遍历 MODULE_KEYS，不含硬编码
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const EXAMPLE = {
  key: 'cash',
  name: '资金管理',
  entity: '资金记录',
  periodField: '会计期间',
  sortField: '会计期间',
  fields: [
    { name: '单位', type: 'text', required: true },
    { name: '会计期间', type: 'date', required: true },
    { name: '款项性质', type: 'select', options: ['项目款', '保证金', '备用金', '其他'] },
    { name: '收款金额(元)', type: 'number' },
    { name: '付款金额(元)', type: 'number' },
    { name: '对方单位', type: 'text' },
    { name: '备注', type: 'text' },
  ],
};

const args = process.argv.slice(2);
if (args.includes('--example')) {
  console.log(JSON.stringify(EXAMPLE, null, 2));
  process.exit(0);
}

const DRY = args.includes('--dry-run');
const specFile = args.find((a) => !a.startsWith('--'));
if (!specFile) {
  console.error('用法：node scripts/new-module.mjs 模块声明.json [--dry-run]');
  console.error('      node scripts/new-module.mjs --example > 我的模块.json');
  process.exit(1);
}

function die(msg) {
  console.error(`[new-module] ${msg}`);
  process.exit(1);
}

/* ---------------- 读取并校验声明 ---------------- */

let spec;
try {
  spec = JSON.parse(readFileSync(resolve(specFile), 'utf8'));
} catch (err) {
  die(`读不了声明文件 ${specFile}：${err.message}`);
}

const KEY_RE = /^[a-z][a-z0-9_]{1,19}$/;
if (!KEY_RE.test(String(spec.key || ''))) {
  die('key 必须是 2~20 位小写字母/数字/下划线，且以字母开头（它会作为文件名与接口路径）');
}
if (!spec.name) die('name（中文模块名）不能为空');
if (!Array.isArray(spec.fields) || !spec.fields.length) die('fields 至少要有一个字段');

const key = spec.key;
const name = String(spec.name);
const entity = String(spec.entity || name);
const periodField = spec.periodField ? String(spec.periodField) : null;
const sortField = String(spec.sortField || periodField || spec.fields[0].name);

const TYPES = ['text', 'number', 'date', 'select'];
const seen = new Set();
for (const f of spec.fields) {
  if (!f || !f.name) die('每个字段都要有 name');
  if (seen.has(f.name)) die(`字段名重复：${f.name}`);
  seen.add(f.name);
  const type = f.type || 'text';
  if (!TYPES.includes(type)) die(`字段「${f.name}」的 type 只能是 ${TYPES.join(' / ')}`);
  if (type === 'select' && (!Array.isArray(f.options) || !f.options.length)) {
    die(`字段「${f.name}」是 select，必须给 options`);
  }
  /* 期间字段在服务端必须是 date：periodOf() 取的是 YYYY-MM 前缀 */
  if (periodField && f.name === periodField && type !== 'date') {
    die(`期间字段「${periodField}」的 type 必须是 date`);
  }
}
if (periodField && !seen.has(periodField)) {
  die(`periodField 是「${periodField}」，但 fields 里没有这个字段`);
}
if (!seen.has(sortField)) die(`sortField 是「${sortField}」，但 fields 里没有这个字段`);
if (!seen.has('单位')) {
  console.warn('[new-module] 提示：字段里没有「单位」。受控清单校验与按单位筛选都依赖它，建议加上。');
}

/* ---------------- 目标文件 ---------------- */

const schemaFile = join(ROOT, 'lib', 'schema.js');
const registryFile = join(ROOT, 'frontend', 'app', 'modules', 'registry.js');
const htmlFile = join(ROOT, 'frontend', 'index.html');
const moduleFile = join(ROOT, 'frontend', 'app', 'modules', `${key}.js`);

for (const f of [schemaFile, registryFile, htmlFile]) {
  if (!existsSync(f)) die(`找不到 ${f}，请在 server/ 目录下运行`);
}
if (existsSync(moduleFile)) die(`${moduleFile} 已存在，先删掉或改个 key`);

const schemaSrc = readFileSync(schemaFile, 'utf8');
const registrySrc = readFileSync(registryFile, 'utf8');
const htmlSrc = readFileSync(htmlFile, 'utf8');

if (new RegExp(`key:\\s*'${key}'`).test(schemaSrc)) die(`lib/schema.js 里已经有模块 ${key}`);
if (htmlSrc.includes(`data-mod="${key}"`)) die(`index.html 里已经有页签 ${key}`);

/* ---------------- 1. lib/schema.js ---------------- */

function jsStr(s) { return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`; }

const schemaFields = spec.fields
  .map((f) => {
    const type = f.type || 'text';
    const opts = type === 'select' ? `, options: [${f.options.map(jsStr).join(', ')}]` : '';
    return `      { name: ${jsStr(f.name)}, type: ${jsStr(type)}${opts} },`;
  })
  .join('\n');

const schemaBlock = `  {
    key: ${jsStr(key)},
    name: ${jsStr(name)},
    entity: ${jsStr(entity)},
    legacyDbId: ${jsStr(key)},
    sortField: ${jsStr(sortField)},
    periodField: ${periodField ? jsStr(periodField) : 'null'},
    fields: [
${schemaFields}
    ],
  },
];`;

const schemaAnchor = '\n];\n\nexport const MODULES = Object.freeze(';
if (!schemaSrc.includes(schemaAnchor)) {
  die('lib/schema.js 的结构和预期不一致（找不到 MODULE_LIST 的结尾），请手动添加后再跑一次');
}
const schemaOut = schemaSrc.replace(schemaAnchor, `\n${schemaBlock}\n\nexport const MODULES = Object.freeze(`);

/* ---------------- 2. frontend/app/modules/<key>.js ---------------- */

const moduleFields = spec.fields
  .map((f) => {
    const type = f.type || 'text';
    const parts = [`name: ${jsStr(f.name)}`, `type: ${jsStr(type)}`];
    if (f.label) parts.push(`label: ${jsStr(f.label)}`);
    if (f.required) parts.push('required: true');
    if (type === 'select') parts.push(`options: [${f.options.map(jsStr).join(', ')}]`);
    if (f.placeholder) parts.push(`placeholder: ${jsStr(f.placeholder)}`);
    return `    { ${parts.join(', ')} },`;
  })
  .join('\n');

const moduleOut = `/**
 * ${name} —— 由 scripts/new-module.mjs 生成。
 *
 * 这是一个「登记 + 汇总」型模块：每行独立，没有跨期推算。
 * 要加口径（例如按月摊销、链式计提、账龄）就在下面的 override 里补：
 *
 *   ${key}.calcAll = function(rows){ ... };     // 需要看上期数据的算法写这里
 *   ${key}.rowCalc = function(r, pe){ ... };    // 每行独立的算法写这里
 *   ${key}.columns = [...];                      // 想自定义列顺序/表头就整段替换
 *   ${key}.buildPrint = function(rows, calcs){ ... };  // 需要正式报表格式时写这里
 *
 * 字段名必须与 lib/schema.js 里的完全一致——服务端按字段名校验，
 * 前端按字段名取值，改一个字就是换了一个字段。
 */
import { makeModule } from './generic.js';

export const ${key} = makeModule({
  key: ${jsStr(key)},
  name: ${jsStr(name)},
  entity: ${jsStr(entity)},
  periodField: ${periodField ? jsStr(periodField) : 'null'},
  sortField: ${jsStr(sortField)},
  fields: [
${moduleFields}
  ],
});
`;

/* ---------------- 3. registry.js ---------------- */

const importLine = `import { ${key} } from './${key}.js';`;
const exportRe = /export const MODULES = \{([^}]*)\};/;
const exportMatch = registrySrc.match(exportRe);
if (!exportMatch) die('registry.js 的结构和预期不一致，请手动添加后再跑一次');

/* import 紧跟在最后一条 import 之后，不要在中间留空行——
   文件只有十行，视觉上的连续性就是它的可读性。 */
const importLines = [...registrySrc.matchAll(/^import .*$/gm)];
if (!importLines.length) die('registry.js 里没有 import 语句，结构和预期不一致');
const lastImport = importLines[importLines.length - 1];
const insertAt = lastImport.index + lastImport[0].length;

let registryOut = registrySrc.slice(0, insertAt) + '\n' + importLine + registrySrc.slice(insertAt);
registryOut = registryOut.replace(exportRe, () => {
  const existing = exportMatch[1].trim().replace(/,$/, '');
  return `export const MODULES = { ${existing}, ${key} };`;
});
/* 首行注释写死了模块个数，加一个模块就不准了。改成不含个数的说法。 */
registryOut = registryOut.replace(
  /^\/\*\*.*注册表.*$/m,
  '/** 台账模块注册表。新增模块只需在这里加一行 import 与一个键（scripts/new-module.mjs 会自动改）。 */',
);

/* ---------------- 4. index.html 页签 ---------------- */

const tabHtml = `  <button class="mod-tab" data-mod="${key}" type="button">${name}</button>\n`;
let htmlOut = htmlSrc;

/*
 * 先看有没有同名的「规划中」占位页签。有就替换掉它，而不是在旁边再加一个。
 * 否则界面上会并排出现两个「资金管理」，一个能点一个弹「该模块规划中」——
 * 这是脚手架第一次跑出来时的真实结果。
 */
const soonRe = new RegExp(
  `[ \\t]*<button[^>]*class="mod-tab soon"[^>]*>(?:(?!</button>).)*?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:(?!</button>).)*?</button>\\n?`,
  's',
);
const soonMatch = htmlOut.match(soonRe);
if (soonMatch) {
  htmlOut = htmlOut.replace(soonRe, tabHtml);
  console.log(`[new-module] 「${name}」原来是「规划中」占位页签，已替换为真实页签。`);
} else {
  /* 插在第一个「规划中」占位页签之前；没有占位页签就插在 </nav> 之前 */
  const firstSoon = htmlOut.search(/[ \t]*<button[^>]*class="mod-tab soon"/);
  if (firstSoon >= 0) {
    htmlOut = htmlOut.slice(0, firstSoon) + tabHtml + htmlOut.slice(firstSoon);
  } else {
    const navEnd = htmlOut.indexOf('</nav>');
    if (navEnd < 0) die('index.html 里找不到 </nav>，请手动加页签');
    htmlOut = htmlOut.slice(0, navEnd) + tabHtml + htmlOut.slice(navEnd);
  }
}

/* ---------------- 写入 ---------------- */

const writes = [
  [schemaFile, schemaOut, '服务端字段定义'],
  [moduleFile, moduleOut, '前端模块定义（新文件）'],
  [registryFile, registryOut, '前端注册表'],
  [htmlFile, htmlOut, '模块页签'],
];

console.log(`\n[new-module] 模块 ${key}（${name}）`);
console.log(`[new-module] 字段 ${spec.fields.length} 个${periodField ? `，按月记录（期间字段：${periodField}）` : '，不按月记录'}`);
console.log('');
for (const [file, , label] of writes) {
  console.log(`  ${DRY ? '将修改' : '已写入'}  ${file.replace(ROOT + '/', '')}  —— ${label}`);
}

if (DRY) {
  console.log('\n[new-module] --dry-run：没有真的写文件。\n');
  process.exit(0);
}

for (const [file, content] of writes) writeFileSync(file, content);

console.log(`
[new-module] 完成。接下来按顺序跑：

  npm run build      # 把 frontend/ 复制到 public/
  npm run verify     # 检查模块图、页签、元素引用是否闭合
  npm run test:all   # 接口 + 前端逻辑自检
  npm start          # 起服务，在浏览器里点开新页签看一眼

要调这个模块的算法或报表格式，改 frontend/app/modules/${key}.js
（怎么改、改哪一段，文件开头的注释里写了）。
`);
