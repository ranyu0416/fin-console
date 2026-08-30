#!/usr/bin/env node
/**
 * 把 Markdown 建议书转成 .docx。
 *
 * 环境里没有 pandoc / libreoffice / zip，所以这里自己拼 OOXML 并用 node:zlib
 * 手写 ZIP 容器。只支持这份文档实际用到的语法：# ~ ####、段落、- 列表、1. 列表、
 * | 表格 |、``` 代码块、`行内代码`、**粗体**、--- 分隔线、> 引用。
 *
 * 不追求通用性——目标是产出一份能在 Word / WPS 里正常打开、样式干净、
 * 中文字体正确的文件，而不是再造一个 Markdown 引擎。
 */
import { deflateRawSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';

const [srcPath, outPath] = process.argv.slice(2);
if (!srcPath || !outPath) {
  console.error('用法：node scripts/md-to-docx.mjs <输入.md> <输出.docx>');
  process.exit(1);
}

/* ---------------- ZIP 容器 ---------------- */
function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const body = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);      // version needed
    local.writeUInt16LE(0, 6);       // flags
    local.writeUInt16LE(8, 8);       // deflate
    local.writeUInt16LE(0, 10);      // time
    local.writeUInt16LE(0x2100, 12); // date（固定值即可，Word 不校验）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x2100, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, end]);
}

/* ---------------- 行内解析 ---------------- */
const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function runs(text) {
  // 先切出 `代码`，再在非代码片段里处理 **粗体**
  const out = [];
  const parts = String(text).split(/(`[^`]*`)/);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
      out.push(
        `<w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="宋体"/>` +
          `<w:shd w:val="clear" w:fill="F2F2F2"/></w:rPr><w:t xml:space="preserve">${esc(part.slice(1, -1))}</w:t></w:r>`,
      );
      continue;
    }
    for (const seg of part.split(/(\*\*[^*]+\*\*)/)) {
      if (!seg) continue;
      const bold = seg.startsWith('**') && seg.endsWith('**') && seg.length > 4;
      const body = bold ? seg.slice(2, -2) : seg;
      out.push(`<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${esc(body)}</w:t></w:r>`);
    }
  }
  return out.join('') || '<w:r><w:t/></w:r>';
}

function para(text, style) {
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${runs(text)}</w:p>`;
}

/**
 * 代码块。Word 里没有「代码块」这个概念，用「等宽字体 + 灰底 + 细边框的单列表格」
 * 来表达：整块有明确边界，也不会被 Word 自动套上正文样式。
 */
function codeBlock(lines) {
  const paras = (lines.length ? lines : [''])
    .map(
      (ln) =>
        '<w:p><w:pPr><w:pStyle w:val="Code"/></w:pPr><w:r><w:rPr>' +
        '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="宋体"/></w:rPr>' +
        `<w:t xml:space="preserve">${esc(ln)}</w:t></w:r></w:p>`,
    )
    .join('');
  const border = (side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="D9D9D9"/>`;
  return (
    '<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('') +
    '</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr>' +
    '<w:tblGrid><w:gridCol w:w="9000"/></w:tblGrid>' +
    '<w:tr><w:tc><w:tcPr><w:tcW w:w="9000" w:type="dxa"/>' +
    '<w:shd w:val="clear" w:fill="F7F7F7"/>' +
    '<w:tcMar><w:top w:w="80" w:type="dxa"/><w:left w:w="120" w:type="dxa"/>' +
    '<w:bottom w:w="80" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tcMar>' +
    `</w:tcPr>${paras}</w:tc></w:tr></w:tbl>` +
    '<w:p><w:pPr><w:pStyle w:val="AfterCode"/></w:pPr></w:p>'
  );
}

function tableXml(rows) {
  const width = 9000;
  const cols = Math.max(...rows.map((r) => r.length));
  const each = Math.floor(width / cols);
  const grid = `<w:tblGrid>${Array.from({ length: cols }, () => `<w:gridCol w:w="${each}"/>`).join('')}</w:tblGrid>`;
  const border = (side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`;
  const body = rows
    .map((cells, ri) => {
      const tds = Array.from({ length: cols }, (_, ci) => {
        const shade = ri === 0 ? '<w:shd w:val="clear" w:fill="EDEDED"/>' : '';
        const inner = ri === 0 ? `<w:p><w:pPr><w:pStyle w:val="TableHead"/></w:pPr>${runs(cells[ci] ?? '')}</w:p>`
                               : `<w:p><w:pPr><w:pStyle w:val="TableCell"/></w:pPr>${runs(cells[ci] ?? '')}</w:p>`;
        return `<w:tc><w:tcPr><w:tcW w:w="${each}" w:type="dxa"/>${shade}</w:tcPr>${inner}</w:tc>`;
      }).join('');
      return `<w:tr>${ri === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${tds}</w:tr>`;
    })
    .join('');
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="${width}" w:type="dxa"/><w:tblBorders>` +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('') +
    `</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr>${grid}${body}</w:tbl>`
  );
}

/* ---------------- 块级解析 ---------------- */
const src = readFileSync(srcPath, 'utf8').split(/\r?\n/);
const blocks = [];
let i = 0;
while (i < src.length) {
  const line = src[i];
  const trimmed = line.trim();

  if (!trimmed) { i += 1; continue; }

  // 围栏代码块：整块原样保留，逐行成段并加底纹。行内不做粗体/代码解析，
  // 否则命令里的 * 和反引号会被当成 Markdown 语法吃掉。
  if (trimmed.startsWith('```')) {
    i += 1;
    const lines = [];
    while (i < src.length && !src[i].trim().startsWith('```')) {
      lines.push(src[i]);
      i += 1;
    }
    i += 1;   // 跳过收尾的 ```
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    blocks.push(codeBlock(lines));
    continue;
  }

  if (/^-{3,}$/.test(trimmed)) {
    blocks.push('<w:p><w:pPr><w:pStyle w:val="Rule"/></w:pPr></w:p>');
    i += 1;
    continue;
  }

  const h = /^(#{1,4})\s+(.*)$/.exec(trimmed);
  if (h) {
    blocks.push(para(h[2], `Heading${h[1].length}`));
    i += 1;
    continue;
  }

  if (trimmed.startsWith('|')) {
    const rows = [];
    while (i < src.length && src[i].trim().startsWith('|')) {
      const cells = src[i].trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      if (!cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) rows.push(cells);
      i += 1;
    }
    if (rows.length) blocks.push(tableXml(rows));
    continue;
  }

  if (trimmed.startsWith('> ')) {
    blocks.push(para(trimmed.slice(2), 'Quote'));
    i += 1;
    continue;
  }

  const ul = /^[-*]\s+(.*)$/.exec(trimmed);
  if (ul) {
    blocks.push(para('· ' + ul[1], 'Bullet'));
    i += 1;
    continue;
  }
  const ol = /^(\d+)\.\s+(.*)$/.exec(trimmed);
  if (ol) {
    blocks.push(para(`${ol[1]}. ${ol[2]}`, 'Bullet'));
    i += 1;
    continue;
  }

  blocks.push(para(trimmed, 'Body'));
  i += 1;
}

/* ---------------- 打包 ---------------- */
const CT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const title = (src.find((l) => /^#\s+/.test(l.trim())) || '# 建议书').trim().replace(/^#\s+/, '');
const CORE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
 xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"
 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${esc(title)}</dc:title><dc:creator>代码评审</dc:creator>
<dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created>
</cp:coreProperties>`;

const font = '<w:rFonts w:ascii="等线" w:hAnsi="等线" w:eastAsia="等线" w:cs="等线"/>';
function style(id, name, { size = 21, bold = false, before = 0, after = 120, color = null, line = 300, outline = null, indent = 0 } = {}) {
  return (
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>` +
    `<w:pPr><w:spacing w:before="${before}" w:after="${after}" w:line="${line}" w:lineRule="auto"/>` +
    (indent ? `<w:ind w:left="${indent}"/>` : '') +
    (outline !== null ? `<w:outlineLvl w:val="${outline}"/>` : '') +
    `</w:pPr><w:rPr>${font}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` +
    (bold ? '<w:b/>' : '') + (color ? `<w:color w:val="${color}"/>` : '') +
    `</w:rPr></w:style>`
  );
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>${font}<w:sz w:val="21"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr>${font}<w:sz w:val="21"/></w:rPr></w:style>
${style('Heading1', 'heading 1', { size: 36, bold: true, before: 240, after: 200, color: '1F3864', outline: 0 })}
${style('Heading2', 'heading 2', { size: 28, bold: true, before: 320, after: 160, color: '1F3864', outline: 1 })}
${style('Heading3', 'heading 3', { size: 24, bold: true, before: 240, after: 120, color: '2E5496', outline: 2 })}
${style('Heading4', 'heading 4', { size: 21, bold: true, before: 200, after: 100, color: '404040', outline: 3 })}
${style('Body', 'Body', { size: 21, after: 140 })}
${style('Bullet', 'Bullet', { size: 21, after: 80, indent: 360 })}
${style('Quote', 'Quote', { size: 21, after: 140, indent: 360, color: '595959' })}
${style('TableHead', 'TableHead', { size: 19, bold: true, after: 40, line: 260 })}
${style('TableCell', 'TableCell', { size: 19, after: 40, line: 260 })}
${style('Code', 'Code', { size: 18, after: 0, line: 240 })}
${style('AfterCode', 'AfterCode', { size: 2, after: 140 })}
${style('Rule', 'Rule', { size: 2, after: 200 })}
</w:styles>`;

const DOC = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${blocks.join('')}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>
<w:pgMar w:top="1440" w:right="1247" w:bottom="1440" w:left="1247" w:header="851" w:footer="992" w:gutter="0"/>
</w:sectPr></w:body></w:document>`;

const buf = zip([
  { name: '[Content_Types].xml', data: Buffer.from(CT, 'utf8') },
  { name: '_rels/.rels', data: Buffer.from(RELS, 'utf8') },
  { name: 'docProps/core.xml', data: Buffer.from(CORE, 'utf8') },
  { name: 'word/document.xml', data: Buffer.from(DOC, 'utf8') },
  { name: 'word/styles.xml', data: Buffer.from(STYLES, 'utf8') },
  { name: 'word/_rels/document.xml.rels', data: Buffer.from(DOC_RELS, 'utf8') },
]);
writeFileSync(outPath, buf);
console.log(`已生成 ${outPath}（${(buf.length / 1024).toFixed(1)} KB，${blocks.length} 个段落/表格）`);
