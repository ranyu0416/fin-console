/** 自 startStr 所在月起、截至 end 所在月，已经过了几个月（含首月）。未开始返回 0。 */
export function monthsElapsedTo(startStr, end){
  if(!startStr) return 0;
  var d = new Date(startStr);
  if(isNaN(d.getTime())) return 0;
  var m = (end.getFullYear() - d.getFullYear()) * 12 + (end.getMonth() - d.getMonth());
  return Math.max(0, m + 1);
}

/** 两个 YYYY-MM 之间相差几个月（to − from）。可为负。 */
export function monthsBetweenYM(fromYM, toYM){
  if(!fromYM || !toYM) return 0;
  var a = String(fromYM).slice(0, 7).split('-');
  var b = String(toYM).slice(0, 7).split('-');
  if(a.length < 2 || b.length < 2) return 0;
  return (+b[0] - +a[0]) * 12 + (+b[1] - +a[1]);
}

export function prevMonthEnd(pe){ return new Date(pe.getFullYear(), pe.getMonth(), 0); }
export function todayStr(){
  var d = new Date();
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
}
export function esc(s){
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
/* 人民币大写 */
export function toCN(num){
  if(num === null || num === undefined || isNaN(num)) return '';
  num = Math.round(num * 100) / 100;
  if(num === 0) return '零元整';
  var cnD = ['零','壹','贰','叁','肆','伍','陆','柒','捌','玖'];
  var cnU = ['','拾','佰','仟'];
  num = Math.abs(num);
  var intPart = Math.floor(num);
  var cents = Math.round((num - intPart) * 100);
  var jf = Math.floor(cents / 10), ff = cents % 10;
  var s = String(intPart), groups = [];
  while(s.length > 0){ groups.unshift(s.slice(-4)); s = s.slice(0, -4); }
  var out = '', zeroPending = false;
  for(var i = 0; i < groups.length; i++){
    var p = groups[i], gu = '', zero = false;
    for(var k = 0; k < p.length; k++){
      var d = +p.charAt(k), u = cnU[p.length - 1 - k];
      if(d === 0){ zero = true; }
      else { if(zero && gu) gu += '零'; gu += cnD[d] + u; zero = false; }
    }
    if(gu){
      if(p.length === 4 && p.charAt(0) === '0') gu = '零' + gu;
      if(out && zeroPending && gu.charAt(0) !== '零') out += '零';
      out += gu + ((groups.length - 1 - i === 1) ? '万' : ((groups.length - 1 - i === 2) ? '亿' : ''));
      zeroPending = false;
    } else {
      zeroPending = true;
    }
  }
  out += '元';
  if(jf === 0 && ff === 0){ out += '整'; }
  else {
    if(jf > 0) out += cnD[jf] + '角';
    else if(ff > 0) out += '零';
    if(ff > 0) out += cnD[ff] + '分';
  }
  return out;
}

