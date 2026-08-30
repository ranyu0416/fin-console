import { toast } from './core/dom.js';
import { ri } from './core/format.js';
import { cur } from './core/state.js';
import { calcsOf, curRows } from './engine.js';

export function download(filename, content, mime){
  var blob = new Blob([content], { type: mime });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
export function exportJson(){
  var rows = curRows(), calcs = calcsOf(rows);
  var data = rows.map(function(r){
    var o = { _id: r._id };
    Object.keys(r).forEach(function(k){ if(k !== '_id') o[k] = r[k]; });
    o._computed = calcs[r._id];
    return o;
  });
  download(cur.name + '台账_' + new Date().toISOString().slice(0, 10) + '.json',
    JSON.stringify(data, null, 2), 'application/json;charset=utf-8');
  toast('已导出 JSON 备份');
}
/* ---------- Excel 导出（标准 .xlsx / OOXML，Excel 与 WPS 零警告直接打开） ---------- */
export function xmlEsc(v){
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
/* ---- 最小 ZIP（仅存储不压缩），CRC32 ---- */
export function crc32(buf){
  var table = crc32.T || (crc32.T = (function(){
    var t = [], c;
    for(var n = 0; n < 256; n++){
      c = n;
      for(var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })());
  var c = 0xFFFFFFFF;
  for(var i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
export function zipStore(files){
  var enc = new TextEncoder();
  function u16(v){ return [v & 255, (v >> 8) & 255]; }
  function u32(v){ return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]; }
  var now = new Date();
  var dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
  var dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;
  var parts = [], central = [], offset = 0;
  files.forEach(function(f){
    var nameB = enc.encode(f.name);
    var crc = crc32(f.bytes);
    parts.push(new Uint8Array([].concat(u32(0x04034b50), u16(20), u16(0x0800), u16(0),
      u16(dosTime), u16(dosDate), u32(crc), u32(f.bytes.length), u32(f.bytes.length),
      u16(nameB.length), u16(0))), nameB, f.bytes);
    central.push({ h: [].concat(u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0),
      u16(dosTime), u16(dosDate), u32(crc), u32(f.bytes.length), u32(f.bytes.length),
      u16(nameB.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset)), n: nameB });
    offset += 30 + nameB.length + f.bytes.length;
  });
  var centralSize = 0;
  central.forEach(function(c){ centralSize += 46 + c.n.length; });
  var eocd = [].concat(u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length),
    u32(centralSize), u32(offset), u16(0));
  var all = parts;
  central.forEach(function(c){ all.push(new Uint8Array(c.h), c.n); });
  all.push(new Uint8Array(eocd));
  return new Blob(all, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
/* ---- 样式索引：sl/sc/n2/n0/pc 明细 → xlsx cellXfs 下标 ---- */
var XL_SIDX = { sl: 5, sc: 6, n2: 7, n0: 8, pc: 9, slB: 10, scB: 11, n2B: 12, n0B: 13, pcB: 14 };
export function xlColRef(n){
  var s = '';
  while(n > 0){ s = String.fromCharCode(65 + (n - 1) % 26) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
export function xlRcToA1(rc){
  var m = String(rc).match(/R(\d+)C(\d+)/);
  return m ? xlColRef(+m[2]) + m[1] : rc;
}
export function xlStylesXml(){
  var THIN = '<left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right>' +
    '<top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/>';
  var FONT = function(bold, size, name){ return '<font>' + (bold ? '<b/>' : '') + '<sz val="' + size + '"/><name val="' + name + '"/><charset val="134"/></font>'; };
  var AL = function(h){ return '<alignment horizontal="' + h + '" vertical="center" wrapText="1"/>'; };
  /* 黑白版式：无底色；apply* 标记缺一不可，否则 Excel 会忽略字体/边框/数字格式 */
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="0&quot;%&quot;"/></numFmts>' +
    '<fonts count="4">' + FONT(false, 11, '宋体') + FONT(true, 16, '黑体') + FONT(false, 10.5, '宋体') + FONT(true, 11, '宋体') + '</fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border>' + THIN + '</border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="15">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>' +                                                                   /* 0 常规 */
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" applyFont="1" applyAlignment="1">' + AL('center') + '</xf>' +           /* 1 标题 */
    '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" applyFont="1" applyAlignment="1">' + AL('left') + '</xf>' +             /* 2 表头行左 */
    '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" applyFont="1" applyAlignment="1">' + AL('right') + '</xf>' +            /* 3 表头行右 */
    '<xf numFmtId="0" fontId="3" fillId="0" borderId="1" applyFont="1" applyBorder="1" applyAlignment="1">' + AL('center') + '</xf>' +   /* 4 列头 */
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyBorder="1" applyAlignment="1">' + AL('left') + '</xf>' +           /* 5 文本左 */
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyBorder="1" applyAlignment="1">' + AL('center') + '</xf>' +         /* 6 文本中 */
    '<xf numFmtId="4" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1" applyAlignment="1">' + AL('right') + '</xf>' +    /* 7 金额 */
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyBorder="1" applyAlignment="1">' + AL('right') + '</xf>' +          /* 8 整数 */
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1" applyAlignment="1">' + AL('center') + '</xf>' + /* 9 比例 */
    '<xf numFmtId="0" fontId="3" fillId="0" borderId="1" applyFont="1" applyBorder="1" applyAlignment="1">' + AL('left') + '</xf>' +      /* 10 文本左·粗 */
    '<xf numFmtId="0" fontId="3" fillId="0" borderId="1" applyFont="1" applyBorder="1" applyAlignment="1">' + AL('center') + '</xf>' +    /* 11 文本中·粗 */
    '<xf numFmtId="4" fontId="3" fillId="0" borderId="1" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1">' + AL('right') + '</xf>' + /* 12 金额·粗 */
    '<xf numFmtId="0" fontId="3" fillId="0" borderId="1" applyFont="1" applyBorder="1" applyAlignment="1">' + AL('right') + '</xf>' +     /* 13 整数·粗 */
    '<xf numFmtId="164" fontId="3" fillId="0" borderId="1" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1">' + AL('center') + '</xf>' + /* 14 比例·粗 */
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="常规" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';
}
/* spec：{file, sheet, title, metaL, metaR, cols:[{h,w,s}], rows:[[值|{v,s,b}]], merges:['R4C1:R4C7']} */
export function exportExcelXls(spec){
  if(!spec || !spec.rows || !spec.rows.length){ toast('当前没有可导出的数据'); return; }
  var enc = new TextEncoder();
  var n = spec.cols.length, lastCol = xlColRef(n);
  var merges = (spec.merges || []).map(function(m){
    var p = m.split(':');
    return '<mergeCell ref="' + xlRcToA1(p[0]) + ':' + xlRcToA1(p[1]) + '"/>';
  });
  function cellXml(v, styleKey, ref){
    var s = XL_SIDX[styleKey] || 6;
    if(typeof v === 'number' && isFinite(v)){
      return '<c r="' + ref + '" s="' + s + '"><v>' + v + '</v></c>';
    }
    return '<c r="' + ref + '" s="' + s + '" t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(v) + '</t></is></c>';
  }
  var rowsXml = [];
  rowsXml.push('<row r="1" ht="32" customHeight="1">' + cellXml(spec.title, 'sc', 'A1').replace('s="6"', 's="1"') + '</row>');
  rowsXml.push('<row r="2" ht="18" customHeight="1">' +
    cellXml(spec.metaL || '', 'sl', 'A2').replace('s="5"', 's="2"') +
    cellXml(spec.metaR || '', 'sc', lastCol + '2').replace('s="6"', 's="3"') + '</row>');
  rowsXml.push('<row r="3" ht="28" customHeight="1">' + spec.cols.map(function(c, i){
    return cellXml(c.h, 'sc', xlColRef(i + 1) + '3').replace('s="6"', 's="4"');
  }).join('') + '</row>');
  spec.rows.forEach(function(rw, ri){
    var r = ri + 4;
    rowsXml.push('<row r="' + r + '" ht="22" customHeight="1">' + rw.map(function(cell, i){
      var st = (spec.cols[i] && spec.cols[i].s) || 'sc';
      if(cell && typeof cell === 'object'){
        var k = cell.s || st;
        if(cell.b && XL_SIDX[k] != null && k.charAt(k.length - 1) !== 'B') k += 'B';
        return cellXml(cell.v, k, xlColRef(i + 1) + r);
      }
      return cellXml(cell, st, xlColRef(i + 1) + r);
    }).join('') + '</row>');
  });
  var sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' +
    '<dimension ref="A1:' + lastCol + (spec.rows.length + 3) + '"/>' +
    '<sheetViews><sheetView tabSelected="1" workbookViewId="0"><pane ySplit="3" topLeftCell="A4" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="22"/>' +
    '<cols>' + spec.cols.map(function(c, i){
      return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + Math.round((c.w || 80) / 6) + '" customWidth="1"/>';
    }).join('') + '</cols>' +
    '<sheetData>' + rowsXml.join('') + '</sheetData>' +
    (merges.length ? '<mergeCells count="' + merges.length + '">' + merges.join('') + '</mergeCells>' : '') +
    '<printOptions horizontalCentered="1"/>' +
    '<pageMargins left="0.6" right="0.6" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
    '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>' +
    '</worksheet>';
  var workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="' + xmlEsc(spec.sheet || '台账') + '" sheetId="1" r:id="rId1"/></sheets></workbook>';
  var wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>';
  var rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';
  var contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>';
  var blob = zipStore([
    { name: '[Content_Types].xml', bytes: enc.encode(contentTypes) },
    { name: '_rels/.rels', bytes: enc.encode(rootRels) },
    { name: 'xl/workbook.xml', bytes: enc.encode(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', bytes: enc.encode(wbRels) },
    { name: 'xl/styles.xml', bytes: enc.encode(xlStylesXml()) },
    { name: 'xl/worksheets/sheet1.xml', bytes: enc.encode(sheet) }
  ]);
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = spec.file;
  document.body.appendChild(a); a.click();
  setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 500);
  toast('已导出 Excel：' + spec.file);
}

