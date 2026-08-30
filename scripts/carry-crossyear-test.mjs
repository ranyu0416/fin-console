/**
 * 连月结转 + 跨年测试 v2（对着本地演示实例跑）。
 * 正确起点：3月已有 5 条记录并结账 → 先结转 3→4（首转），再连转到 2027-02（跨年），
 * 每期填累计产值、逐条核验链条，每期结账，最终做开累单调性与跨年连续性断言。
 */
const BASE = 'http://127.0.0.1:8788';
const jar = new Map();

async function api(path, { method = 'GET', body } = {}) {
  const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const init = { method, headers: { Accept: 'application/json', Origin: BASE, ...(cookie ? { Cookie: cookie } : {}) } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const resp = await fetch(BASE + path, init);
  for (const raw of resp.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    jar.set(pair.slice(0, pair.indexOf('=')).trim(), pair.slice(pair.indexOf('=') + 1).trim());
  }
  const data = await resp.json();
  if (resp.status >= 400) throw new Error(`${method} ${path} → ${resp.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

function ymAdd(s, m) {
  const d = new Date(+s.slice(0, 4), +s.slice(5, 7) - 1 + m, 1);
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
}

const DELTA = { '示例项目一': 1_400_000, '示例项目二': 700_000, '示例项目三': 800_000, '示例项目四': 600_000, '示例项目五': 300_000 };
let bad = 0;
function assert(cond, msg) {
  if (!cond) { bad += 1; console.log('  ✗ ' + msg); } else console.log('  ✓ ' + msg);
}

async function main() {
  await api('/api/login', { method: 'POST', body: { username: 'admin', password: 'Demo123456' } });

  const cum = {};   // 项目 → 当前累计产值
  const rate = {};  // 项目 → 计提比例
  let prev = null;

  // 结转序列：3→4（首转），4→5，…，2026-12→2027-01（跨年），…→2027-02
  const seq = [];
  let m = '2026-03';
  for (let i = 0; i < 11; i++) { const n = ymAdd(m, 1); seq.push([m, n]); m = n; }
  console.log('结转序列:', seq.map(([a, b]) => `${a}→${b}`).join(', '));

  for (const [from, to] of seq) {
    const yearTurn = from.slice(0, 4) !== to.slice(0, 4);
    console.log(`\n=== ${from} → ${to}${yearTurn ? '  ★跨年' : ''} ===`);

    const preview = await api(`/api/carry/levy?from=${from}&to=${to}`);
    assert(preview.items.length === 5, `名册 5 条（实际 ${preview.items.length}）`);

    const values = {};
    for (const item of preview.items) {
      const ref = Number(item.reference || 0);
      const step = DELTA[item.project] || 500_000;
      cum[item.project] = (prev === null ? ref : Number(cum[item.project] || ref)) + (prev === null ? 500_000 : step);
      if (prev === null) cum[item.project] = ref + 500_000;
      rate[item.project] = Number(item.carried['计提比例(%)'] || 0);
      values[item.identity] = String(cum[item.project]);
    }

    const out = await api('/api/carry/levy', { method: 'POST', body: { from, to, values } });
    assert(out.ok && out.inserted === 5 && out.skipped === 0, `插入 5 条（实际 ${out.inserted}，跳过 ${out.skipped}）`);

    const recs = await api(`/api/modules/levy/records?period=${to}`);
    assert(recs.results.length === 5, `本期记录 5 条`);
    for (const r of recs.results) {
      const p = r['项目名称'];
      const gotCum = Number(r['累计产值(元)'] || 0);
      assert(gotCum === cum[p], `${p} 累计产值 ${gotCum.toLocaleString()} = 填充值`);
      const base = gotCum - (cum[p] - DELTA[p]);
      const expectAmt = Math.round(base * rate[p]) / 100;
      const gotAmt = Number(r['本期计提金额(元)'] || 0);
      assert(Math.abs(gotAmt - expectAmt) < 0.01, `${p} 计提 ${gotAmt.toLocaleString()} = 当期产值 ${base.toLocaleString()} × ${rate[p]}%`);
    }

    await api('/api/closures', { method: 'POST', body: { module: 'levy', period: to, closed: true } });
    prev = to;
  }

  const turn = seq.find(([a, b]) => a.slice(0, 4) !== b.slice(0, 4));
  console.log(`\n=== 跨年专项核验（${turn[1]}）===`);
  const jan = await api(`/api/modules/levy/records?period=${turn[1]}`);
  assert(jan.results.length === 5, `${turn[1]} 记录 5 条`);
  for (const r of jan.results) {
    const gotCum = Number(r['累计产值(元)'] || 0);
    const expect = cum[r['项目名称']];
    assert(gotCum === expect, `${r['项目名称']} 跨年累计 ${gotCum.toLocaleString()} 连续`);
    const gotPeriod = r['会计期间'];
    assert(gotPeriod === turn[1] + '-01', `${r['项目名称']} 跨年期间落库 ${gotPeriod}`);
  }

  const all = await api('/api/modules/levy/records');
  const byProject = {};
  for (const r of all.results.sort((a, b) => (a['会计期间'] < b['会计期间'] ? -1 : 1))) {
    const p = r['项目名称'];
    const v = Number(r['累计产值(元)'] || 0);
    if (byProject[p] !== undefined) assert(v > byProject[p], `${p} 开累回退：${byProject[p]} → ${v}`);
    byProject[p] = v;
  }
  console.log(`\n全量链条：${Object.keys(byProject).length} 项目 × ${all.results.length} 期单调递增 ✓`);
  console.log(bad === 0 ? '\n★★★ 连月结转 + 跨年测试全部通过 ★★★' : `\n共有 ${bad} 处断言失败！`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((e) => { console.error('脚本异常:', e.message); process.exit(1); });
