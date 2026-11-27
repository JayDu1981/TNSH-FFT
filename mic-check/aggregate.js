import { THIRD_OCT } from './analysis.js';

const $ = (id) => document.getElementById(id);
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const rows = new Map(); // key -> record

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function addFiles(list) {
  for (const f of list) {
    if (!/\.json$/i.test(f.name)) continue;
    try {
      const j = JSON.parse(await f.text());
      if (j.schema !== 'mic-check-result') continue;
      rows.set(f.name, { file: f.name, ...j });
    } catch (e) { console.warn('無法讀取', f.name, e); }
  }
  render();
}

const drop = $('drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); });
$('files').addEventListener('change', (e) => addFiles(e.target.files));

const V = { clean: '✓', modified: '✗', unknown: '?' };
const settingTxt = (s) => (!s ? '' : ['autoGainControl', 'noiseSuppression', 'echoCancellation']
  .map((k) => (s[k] === true ? '開' : s[k] === false ? '關' : '–')).join('/'));

function roundCells(r) {
  if (!r || !r.analysis || !r.analysis.ok) return { verdict: '', detail: r && r.analysis ? r.analysis.error || '' : '', set: '' };
  const m = r.analysis.metrics;
  const agc = Math.max(Math.abs(m.agc1), Math.abs(m.agc2), Math.abs(m.agc3));
  return {
    verdict: V[r.analysis.verdict] || '',
    raw: r.analysis.verdict,
    detail: `${m.d12} / ${m.d23}｜${agc.toFixed(1)}｜${m.noiseRise}｜${m.harmDecay}`,
    set: settingTxt(r.mic && r.mic.settings),
    m,
  };
}

function platform(r) {
  const os = (r.device && r.device.os) || '';
  if (/iOS|iPadOS/.test(os)) return 'iOS';
  if (/Android/.test(os)) return 'Android';
  return os || '其他';
}

function render() {
  const list = [...rows.values()].sort((a, b) => (Number(a.group) || 0) - (Number(b.group) || 0));
  const has = list.length > 0;
  for (const id of ['summaryCard', 'tableCard', 'chartCard']) $(id).classList.toggle('hidden', !has);
  if (!has) return;

  // 總覽
  const stat = {};
  for (const r of list) {
    const p = platform(r);
    stat[p] = stat[p] || { n: 0, bClean: 0, bMod: 0, aMod: 0 };
    stat[p].n++;
    const b = r.rounds && r.rounds.B && r.rounds.B.analysis;
    const a = r.rounds && r.rounds.A && r.rounds.A.analysis;
    if (b && b.ok && b.verdict === 'clean') stat[p].bClean++;
    if (b && b.ok && b.verdict === 'modified') stat[p].bMod++;
    if (a && a.ok && a.verdict === 'modified') stat[p].aMod++;
  }
  $('summary').innerHTML = `<div><span class="muted small">結果檔</span><b>${list.length}</b></div>` +
    Object.entries(stat).map(([p, s]) => `<div><span class="muted small">${esc(p)}（${s.n} 支）</span>
      <b>B 模式乾淨 ${s.bClean}/${s.n}</b><span class="small">B 仍被修改 ${s.bMod}；A 預設被修改 ${s.aMod}</span></div>`).join('');

  const ios = stat.iOS;
  let concl = '';
  if (ios) {
    if (ios.bMod === 0 && ios.bClean >= Math.max(1, Math.ceil(ios.n * 0.7))) concl = '<div class="note ok"><strong>iOS：B 模式在測到的手機上都沒有被修改。</strong>網頁版方案可行。</div>';
    else if (ios.bMod > 0) concl = `<div class="note bad"><strong>iOS：有 ${ios.bMod} 支手機在 B 模式仍被修改。</strong>先檢查是不是同一個 iOS 版本或機型；若普遍如此，就要考慮把網頁包成原生 App。</div>`;
    else concl = '<div class="note warn"><strong>iOS：資料不足以判斷</strong>（很多手機訊號太小或太吵）。</div>';
  }
  $('conclusion').innerHTML = concl;

  // 表格
  const head = ['組', '手機', '系統', '瀏覽器', '開啟', 'A 判定', 'A 數值', 'A 回報 AGC/NS/EC', 'B 判定', 'B 數值', 'B 回報 AGC/NS/EC', '重播 A/B/存檔', '備註'];
  const body = list.map((r) => {
    const a = roundCells(r.rounds && r.rounds.A), b = roundCells(r.rounds && r.rounds.B);
    const d = r.device || {};
    const pr = r.practical || {};
    const ctxs = new Set(Object.values(r.rounds || {}).map((x) => x.context));
    return [
      r.group, r.model, `${d.os || ''} ${d.osVersion || ''}`, d.browser || '', [...ctxs].map((c) => (c === 'home-screen' ? '主畫面' : '分頁')).join('、'),
      a.verdict, a.detail, a.set, b.verdict, b.detail, b.set,
      `${pr.playA ? '✓' : '–'}/${pr.playB ? '✓' : '–'}/${pr.save ? '✓' : '–'}`,
      [r.notes, r.freeNotes].filter(Boolean).join('；'),
    ];
  });
  $('table').innerHTML = `<tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>` +
    body.map((cols) => `<tr>${cols.map((c, i) => `<td class="${[5, 8].includes(i) ? 'num' : ''}">${esc(c)}</td>`).join('')}</tr>`).join('');
  $('csvBtn').onclick = () => {
    const csv = [head, ...body].map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
    a.download = 'mic-check-summary.csv';
    a.click();
  };

  drawDiff(list);
}

function drawDiff(list) {
  const c = $('diffChart');
  const r = c.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  c.width = r.width * dpr; c.height = r.height * dpr;
  const g = c.getContext('2d');
  const w = c.width, h = c.height;
  const padL = 46 * dpr, padR = 10 * dpr, padT = 10 * dpr, padB = 26 * dpr;
  const lo = -20, hi = 20;
  const xv = (i) => padL + (i / (THIRD_OCT.length - 1)) * (w - padL - padR);
  const yv = (v) => padT + ((hi - Math.max(lo, Math.min(hi, v))) / (hi - lo)) * (h - padT - padB);
  g.font = `${11 * dpr}px sans-serif`; g.fillStyle = css('--muted'); g.strokeStyle = css('--line');
  for (let v = lo; v <= hi; v += 10) { g.beginPath(); g.moveTo(padL, yv(v)); g.lineTo(w - padR, yv(v)); g.stroke(); g.fillText(`${v} dB`, 2 * dpr, yv(v) + 4 * dpr); }
  THIRD_OCT.forEach((f, i) => { if (i % 3 === 0) g.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, xv(i) - 8 * dpr, h - 8 * dpr); });
  const colors = { iOS: css('--spec-b'), Android: '#3fb950' };
  for (const rec of list) {
    const a = rec.rounds && rec.rounds.A && rec.rounds.A.analysis, b = rec.rounds && rec.rounds.B && rec.rounds.B.analysis;
    if (!a || !b || !a.ok || !b.ok) continue;
    const sa = a.metrics.sweep, sb = b.metrics.sweep;
    const ref = (s) => s.find((x) => x.f === 1000).db;
    const ra = ref(sa), rb = ref(sb);
    g.strokeStyle = colors[platform(rec)] || '#999'; g.globalAlpha = 0.7; g.lineWidth = 1.8 * dpr;
    g.beginPath();
    let pen = false;
    sa.forEach((x, i) => {
      const y = sb[i].db === null || x.db === null ? null : (sb[i].db - rb) - (x.db - ra);
      if (y === null) { pen = false; return; }
      if (!pen) { g.moveTo(xv(i), yv(y)); pen = true; } else g.lineTo(xv(i), yv(y));
    });
    g.stroke();
  }
  g.globalAlpha = 1;
  g.fillStyle = colors.iOS; g.fillText('— iOS', w - 120 * dpr, 20 * dpr);
  g.fillStyle = colors.Android; g.fillText('— Android', w - 70 * dpr, 20 * dpr);
}
