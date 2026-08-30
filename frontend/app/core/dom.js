/** 最小 DOM 工具：选择器、提示条、同步状态徽标、状态药丸。 */
import { esc } from './text.js';

export function $(sel) { return document.querySelector(sel); }

export function toast(msg) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.style.display = 'block';
  setTimeout(function () { t.style.display = 'none'; }, 2600);
}

export function setSync(state) {
  const b = $('#syncBadge');
  const txt = $('#syncText');
  if (!b || !txt) return;
  b.className = 'sync-badge' + (state === 'synced' ? '' : ' ' + state);
  txt.textContent = state === 'synced' ? '已同步' : (state === 'syncing' ? '同步中' : '离线模式');
  const tip = $('#offlineTip');
  if (tip) tip.className = 'offline-tip' + (state === 'offline' ? ' show' : '');
}

/** 状态药丸：使用中/处理中 → 绿；已摊完/已提完/已结账 → 蓝；其余 → 灰 */
export function statusPill(text) {
  const cls = (text === '使用中' || text === '处理中') ? 'use'
    : ((text === '已摊完' || text === '已提完' || text === '已结账') ? 'done' : 'gone');
  return '<span class="pill ' + cls + '">' + esc(text) + '</span>';
}
