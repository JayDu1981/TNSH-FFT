import * as P from './program.js';
import { encodeWav } from './analysis.js';

const $ = (id) => document.getElementById(id);
let ctx = null;
let current = null; // 正在播放的 source
let toneNode = null;
let buffer = null;
let raf = 0;

function ensureCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state !== 'running') ctx.resume();
  return ctx;
}

function getBuffer() {
  if (!buffer || buffer.sampleRate !== ctx.sampleRate) {
    const data = P.generateProgram(ctx.sampleRate);
    buffer = ctx.createBuffer(1, data.length, ctx.sampleRate);
    buffer.getChannelData(0).set(data);
  }
  return buffer;
}

const COLORS = { marker: '#8250df', gap: '#6e7781', steps: '#1f6feb', silence: '#57606a', harm: '#bf3989', sweep: '#1a7f37', end: '#6e7781' };
function drawTimeline() {
  const tl = $('timeline');
  tl.innerHTML = P.SEGMENTS.map((s) => {
    const w = ((s.end - s.start) / P.PROGRAM_END) * 100;
    const short = { marker: '嗶', steps: '①', silence: '③', harm: '②', sweep: '④' }[s.key] || '';
    return `<div style="width:${w}%;background:${COLORS[s.key]}">${short}</div>`;
  }).join('');
}

function stopAll() {
  if (current) { try { current.stop(); } catch (e) { /* 忽略 */ } current = null; }
  cancelAnimationFrame(raf);
  $('playBtn').disabled = false;
  $('stopBtn').disabled = true;
}

function log(msg) {
  const ul = $('log');
  if (ul.querySelector('.muted')) ul.innerHTML = '';
  const t = new Date();
  const li = document.createElement('li');
  li.textContent = `${t.toLocaleTimeString('zh-TW', { hour12: false })}　${msg}`;
  ul.prepend(li);
}

$('playBtn').onclick = () => {
  ensureCtx();
  stopTone();
  stopAll();
  const src = ctx.createBufferSource();
  src.buffer = getBuffer();
  src.connect(ctx.destination);
  const t0 = ctx.currentTime + 0.1;
  src.start(t0);
  current = src;
  const label = $('roundLabel').value;
  $('playBtn').disabled = true;
  $('stopBtn').disabled = false;
  $('playStatus').className = 'status wait';
  $('playStatus').textContent = `播放中：${label}　請全班保持安靜`;
  src.onended = () => {
    if (current !== src) return;
    current = null;
    cancelAnimationFrame(raf);
    $('playBtn').disabled = false; $('stopBtn').disabled = true;
    $('playStatus').className = 'status ok';
    $('playStatus').textContent = `播放完畢：${label}。請確認學生手機都顯示「完成」。`;
    $('nowSeg').textContent = '—';
    $('playProg').style.width = '100%';
    log(`播放完成：${label}`);
    // 自動切到下一輪
    const sel = $('roundLabel');
    if (sel.selectedIndex === 0) sel.selectedIndex = 1;
  };
  const tick = () => {
    const t = ctx.currentTime - t0 - P.LEAD_IN;
    const seg = P.segmentAt(t);
    $('nowSeg').textContent = t < 0 ? '準備…' : seg ? seg.label : '—';
    $('playProg').style.width = Math.max(0, Math.min(100, (t / P.PROGRAM_END) * 100)) + '%';
    raf = requestAnimationFrame(tick);
  };
  tick();
};

$('stopBtn').onclick = () => {
  stopAll();
  $('playStatus').className = 'status bad';
  $('playStatus').textContent = '已停止（這一輪學生的錄音會不完整，需要重播）';
  log(`中途停止：${$('roundLabel').value}`);
};

function stopTone() {
  if (toneNode) {
    try { toneNode.stop(); } catch (e) { /* 忽略 */ }
    toneNode = null;
    $('toneBtn').textContent = '播放 1000 Hz 持續音';
  }
}

$('toneBtn').onclick = () => {
  ensureCtx();
  if (toneNode) { stopTone(); return; }
  stopAll();
  const osc = ctx.createOscillator();
  osc.frequency.value = P.STEP_FREQ;
  const g = ctx.createGain();
  g.gain.value = P.dbToAmp(P.STEPS[0].dbfs); // 和測試程序第一段同音量
  osc.connect(g).connect(ctx.destination);
  osc.start();
  toneNode = osc;
  $('toneBtn').textContent = '■ 停止持續音';
};

$('dlWav').onclick = () => {
  const sr = 48000;
  const blob = new Blob([encodeWav(P.generateProgram(sr), sr)], { type: 'audio/wav' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mic-check-program-v${P.PROGRAM_VERSION}.wav`;
  document.body.appendChild(a); a.click(); a.remove();
};

const studentUrl = new URL('./', location.href).href;
$('studentUrl').textContent = studentUrl;
drawTimeline();

// QR code（失敗時只顯示網址）
try {
  const q = window.qrcode(0, 'M');
  q.addData(studentUrl);
  q.make();
  $('qr').innerHTML = q.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  const svg = $('qr').querySelector('svg');
  if (svg) { svg.style.width = '220px'; svg.style.height = '220px'; svg.style.background = '#fff'; }
} catch (e) {
  $('qr').innerHTML = '<span class="small muted">（QR code 產生失敗，請直接提供網址）</span>';
}
