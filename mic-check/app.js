import * as P from './program.js';
import * as A from './analysis.js';

const UPLOAD_URL = 'https://drive.google.com/drive/u/1/folders/1fbT_JRJ_xu58Pia8LC3YKuCqIVEk1MoX';
const STORE_KEY = 'micCheck.v1';
const APP_VERSION = '1.0.0';

const CONSTRAINTS = {
  A: { audio: true },
  B: { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } },
};
const MODE_NAME = { A: 'A 模式（手機預設）', B: 'B 模式（要求關閉美化）' };

const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---------------- 狀態保存 ----------------
let state = loadState();
const recordings = { A: null, B: null }; // Float32Array（只在記憶體中）

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (s && s.v === 1) return s;
  } catch (e) { /* 無法讀取就從頭開始 */ }
  return { v: 1, info: {}, rounds: {}, practical: {}, notes: '', freeNotes: '', micChecked: false };
}
function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* 忽略 */ }
  updateNav();
}

// ---------------- 裝置資訊 ----------------
function deviceInfo() {
  const ua = navigator.userAgent;
  let os = '未知', osVersion = '';
  const ios = ua.match(/OS (\d+)[_.](\d+)(?:[_.](\d+))? like Mac OS X/);
  const android = ua.match(/Android ([\d.]+)/);
  const iPadDesktop = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  if (ios) { os = /iPad/.test(ua) ? 'iPadOS' : 'iOS'; osVersion = [ios[1], ios[2], ios[3]].filter(Boolean).join('.'); }
  else if (iPadDesktop) { os = 'iPadOS'; const v = ua.match(/Version\/([\d.]+)/); osVersion = v ? v[1] + '（推測）' : ''; }
  else if (android) { os = 'Android'; osVersion = android[1]; }
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/Linux/.test(ua)) os = 'Linux';

  let browser = '其他';
  if (/Line\//i.test(ua)) browser = 'LINE 內建';
  else if (/FBAN|FBAV|Instagram/i.test(ua)) browser = 'Facebook/IG 內建';
  else if (/CriOS/.test(ua)) browser = 'Chrome（iOS）';
  else if (/FxiOS/.test(ua)) browser = 'Firefox（iOS）';
  else if (/EdgiOS|EdgA|Edg\//.test(ua)) browser = 'Edge';
  else if (/SamsungBrowser/.test(ua)) browser = 'Samsung 瀏覽器';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua)) browser = 'Safari';

  const standalone = !!(navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches));
  return {
    os, osVersion, browser, standalone,
    userAgent: ua,
    secure: window.isSecureContext,
    hasMediaDevices: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    hasAudioWorklet: typeof AudioWorkletNode !== 'undefined',
    hasAudioSession: 'audioSession' in navigator,
    screen: `${screen.width}×${screen.height} @${window.devicePixelRatio}x`,
  };
}
const DEV = deviceInfo();

function renderDeviceInfo() {
  const rows = [
    ['作業系統', `${DEV.os} ${DEV.osVersion}`],
    ['瀏覽器', DEV.browser],
    ['開啟方式', DEV.standalone ? '從主畫面開啟' : '在瀏覽器分頁中'],
    ['可使用麥克風', DEV.hasMediaDevices && DEV.secure ? '是' : '否 ⚠️'],
  ];
  $('deviceInfo').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
  if (/內建/.test(DEV.browser)) $('lineWarn').classList.remove('hidden');
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------- 音訊引擎 ----------------
let ctx = null;
let workletReady = null;
let session = null; // 目前開著的麥克風

function ensureContext() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    if (ctx.audioWorklet) workletReady = ctx.audioWorklet.addModule('worklet.js').catch(() => null);
  }
  // 必須在按鈕事件中呼叫（iOS 規定）
  if (ctx.state !== 'running') ctx.resume();
  return ctx;
}

async function openMic(mode, onChunk) {
  closeMic();
  ensureContext();
  if ('audioSession' in navigator) {
    try { navigator.audioSession.type = 'play-and-record'; } catch (e) { /* 忽略 */ }
  }
  const stream = await navigator.mediaDevices.getUserMedia(CONSTRAINTS[mode]);
  await ctx.resume();
  const track = stream.getAudioTracks()[0];
  const settings = track.getSettings ? track.getSettings() : {};
  let capabilities = null;
  try { capabilities = track.getCapabilities ? track.getCapabilities() : null; } catch (e) { capabilities = null; }
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 8192;
  analyser.smoothingTimeConstant = 0.6;
  src.connect(analyser);
  const sink = ctx.createGain();
  sink.gain.value = 0;
  sink.connect(ctx.destination);

  let node;
  let captureMethod;
  const wl = workletReady ? await workletReady : null;
  if (ctx.audioWorklet && wl !== null && typeof AudioWorkletNode !== 'undefined') {
    node = new AudioWorkletNode(ctx, 'capture-processor', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
    node.port.onmessage = (e) => onChunk && onChunk(e.data);
    captureMethod = 'AudioWorklet';
  } else {
    node = ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e) => onChunk && onChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
    captureMethod = 'ScriptProcessor';
  }
  src.connect(node);
  node.connect(sink);

  session = {
    mode, stream, track, src, analyser, node, sink,
    info: {
      requested: CONSTRAINTS[mode],
      settings: plain(settings),
      capabilities: plain(capabilities),
      trackLabel: track.label || '',
      sampleRate: ctx.sampleRate,
      baseLatency: ctx.baseLatency ?? null,
      captureMethod,
    },
  };
  return session;
}

function closeMic() {
  if (!session) return;
  try { session.src.disconnect(); } catch (e) { /* 忽略 */ }
  try { session.node.disconnect(); } catch (e) { /* 忽略 */ }
  if (session.node.port) session.node.port.onmessage = null;
  session.node.onaudioprocess = null;
  session.stream.getTracks().forEach((t) => t.stop());
  session = null;
  if ('audioSession' in navigator) {
    try { navigator.audioSession.type = 'auto'; } catch (e) { /* 忽略 */ }
  }
  stopAllLive();
}

function plain(o) {
  if (!o) return o;
  try { return JSON.parse(JSON.stringify(o)); } catch (e) { return null; }
}

function micErrorText(err) {
  const n = err && err.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') return '麥克風權限被拒絕。請看最下面「問題排除」的第一項，開啟權限後重新整理網頁。';
  if (n === 'NotFoundError') return '找不到麥克風。';
  if (n === 'NotReadableError') return '麥克風被其他 App 占用中（例如正在通話或錄音），請關掉後再試。';
  if (!DEV.hasMediaDevices) return '這個瀏覽器不能使用麥克風。請改用 Safari 或 Chrome 開啟。';
  return `無法開啟麥克風：${n || ''} ${err && err.message ? err.message : ''}`;
}

// ---------------- 即時頻譜繪圖 ----------------
const liveLoops = new Set();
function stopAllLive() { liveLoops.forEach((l) => (l.running = false)); liveLoops.clear(); }

function fitCanvas(c) {
  const r = c.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return { w, h, dpr };
}

const FMIN = 50, FMAX = 12000;
const xOfF = (f, w) => (Math.log(f / FMIN) / Math.log(FMAX / FMIN)) * w;

function drawSpecGrid(g, w, h, dpr, dbMin, dbMax) {
  g.fillStyle = css('--spec-bg'); g.fillRect(0, 0, w, h);
  g.strokeStyle = css('--spec-grid'); g.lineWidth = 1;
  g.fillStyle = '#8d97ab'; g.font = `${11 * dpr}px sans-serif`;
  for (const f of [100, 200, 500, 1000, 2000, 5000, 10000]) {
    const x = xOfF(f, w);
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
    g.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 3 * dpr, h - 4 * dpr);
  }
  for (let d = Math.ceil(dbMax / 20) * 20; d > dbMin; d -= 20) {
    const y = ((dbMax - d) / (dbMax - dbMin)) * h;
    g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
    g.fillText(`${d} dB`, 3 * dpr, y - 3 * dpr);
  }
}

function startLiveSpectrum(canvas, analyser, color) {
  const loop = { running: true };
  liveLoops.add(loop);
  const data = new Float32Array(analyser.frequencyBinCount);
  const sr = analyser.context.sampleRate;
  const df = sr / analyser.fftSize;
  const dbMin = -130, dbMax = -10;
  const g = canvas.getContext('2d');
  const tick = () => {
    if (!loop.running) return;
    const { w, h, dpr } = fitCanvas(canvas);
    analyser.getFloatFrequencyData(data);
    drawSpecGrid(g, w, h, dpr, dbMin, dbMax);
    g.strokeStyle = color; g.lineWidth = 1.6 * dpr; g.beginPath();
    let started = false, pk = -1, pv = -Infinity;
    for (let k = 1; k < data.length; k++) {
      const f = k * df;
      if (f < FMIN) continue;
      if (f > FMAX) break;
      const v = data[k];
      if (f > 80 && v > pv) { pv = v; pk = k; }
      const x = xOfF(f, w);
      const y = ((dbMax - Math.max(dbMin, Math.min(dbMax, v))) / (dbMax - dbMin)) * h;
      if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
    }
    g.stroke();
    if (pk > 0 && pv > -100) {
      const y0 = data[pk - 1], y1 = data[pk], y2 = data[pk + 1];
      const den = y0 - 2 * y1 + y2;
      const d = den === 0 ? 0 : (0.5 * (y0 - y2)) / den;
      const fpk = (pk + d) * df;
      const x = xOfF(fpk, w);
      g.fillStyle = '#ffffff'; g.font = `bold ${14 * dpr}px sans-serif`;
      const label = `${fpk.toFixed(0)} Hz ${noteName(fpk)}`;
      const tw = g.measureText(label).width;
      g.fillText(label, Math.min(Math.max(4 * dpr, x - tw / 2), w - tw - 4 * dpr), 18 * dpr);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return loop;
}

function noteName(f) {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const n = Math.round(12 * Math.log2(f / 440)) + 69;
  if (!isFinite(n)) return '';
  return `(${names[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1})`;
}

// ---------------- 3 收音檢查 ----------------
function setupMicCheck() {
  const status = $('micStatus');
  let recent = [];
  let timer = null;
  $('micCheckBtn').onclick = async () => {
    status.className = 'status wait'; status.textContent = '正在開啟麥克風…';
    recent = [];
    try {
      const s = await openMic('B', (chunk) => {
        recent.push(chunk);
        let total = recent.reduce((a, c) => a + c.length, 0);
        while (total > 16384 && recent.length > 1) { total -= recent.shift().length; }
      });
      status.className = 'status ok'; status.textContent = '麥克風已開啟 ✓';
      state.micChecked = true; saveState();
      $('micLive').classList.remove('hidden');
      startLiveSpectrum($('micSpec'), s.analyser, css('--spec-b'));
      clearInterval(timer);
      timer = setInterval(() => {
        if (!session || session !== s) { clearInterval(timer); return; }
        const x = concat(recent);
        if (x.length < 8192) return;
        const spec = A.welch(x, ctx.sampleRate, 0, x.length / ctx.sampleRate, 8192);
        const lv = A.toneLevel(spec, 1000).db;
        let peak = 0; for (const v of x) peak = Math.max(peak, Math.abs(v));
        const pct = Math.max(0, Math.min(100, ((lv + 100) / 100) * 100));
        const bar = $('micMeter');
        bar.style.width = pct + '%';
        let msg, color;
        if (peak > 0.98) { msg = '太大聲（爆音）：請老師調小音量或手機離遠一點'; color = css('--bad'); }
        else if (lv < -75) { msg = '沒聽到 1000 Hz，或太小聲'; color = css('--warn'); }
        else { msg = '音量適中 ✓'; color = css('--ok'); }
        bar.style.background = color;
        $('micLevel').innerHTML = `1000 Hz 音量：<strong>${lv.toFixed(1)} dB</strong>　${msg}`;
      }, 250);
    } catch (err) {
      status.className = 'status bad'; status.textContent = micErrorText(err);
    }
  };
  $('micStopBtn').onclick = () => {
    closeMic(); clearInterval(timer);
    $('micLive').classList.add('hidden');
    status.className = 'status ok'; status.textContent = '收音檢查完成，可以進行 A 回合。';
  };
}

function concat(chunks) {
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Float32Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// ---------------- 4/5 回合 ----------------
const roundUI = {};

function setupRound(mode) {
  const host = document.querySelector(`[data-round="${mode}"]`);
  host.appendChild($('roundTpl').content.cloneNode(true));
  const q = (sel) => host.querySelector(sel);
  const ui = {
    start: q('[data-act=start]'), cancel: q('[data-act=cancel]'), redo: q('[data-act=redo]'),
    status: q('[data-el=status]'), live: q('[data-el=live]'), seg: q('[data-el=seg]'),
    prog: q('[data-el=prog]'), spec: q('[data-el=spec]'), summary: q('[data-el=summary]'),
  };
  roundUI[mode] = ui;
  let run = null;

  const setStatus = (cls, txt) => { ui.status.className = 'status ' + cls; ui.status.textContent = txt; };

  const begin = async () => {
    setStatus('wait', '正在開啟麥克風…');
    ui.start.disabled = true; ui.redo.classList.add('hidden');
    ui.summary.innerHTML = '';
    const sr0 = ensureContext().sampleRate;
    const r = {
      chunks: [], first: 0, total: 0, detector: new A.MarkerDetector(sr0), marker: null, done: false,
      startedAt: Date.now(),
    };
    run = r;
    try {
      const s = await openMic(mode, (chunk) => onChunk(r, chunk));
      r.sr = ctx.sampleRate;
      if (r.sr !== sr0) r.detector = new A.MarkerDetector(r.sr);
      r.session = s;
      ui.cancel.classList.remove('hidden');
      ui.live.classList.remove('hidden');
      ui.seg.textContent = '等待中…';
      ui.prog.style.width = '0%';
      startLiveSpectrum(ui.spec, s.analyser, mode === 'A' ? css('--spec-a') : css('--spec-b'));
      setStatus('wait', '等待老師播放測試音…（聽到「嗶」聲會自動開始錄音）');
    } catch (err) {
      setStatus('bad', micErrorText(err));
      ui.start.disabled = false;
      run = null;
    }
  };

  const onChunk = (r, chunk) => {
    if (r.done || run !== r) return;
    const sr = r.sr || ctx.sampleRate;
    r.chunks.push(chunk);
    r.total += chunk.length;
    if (r.marker === null) {
      const m = r.detector.push(chunk);
      if (m !== null) {
        r.marker = m;
        setStatus('wait', '偵測到提示音，錄音中…請保持安靜，不要碰手機');
      } else {
        // 還沒偵測到：只保留最後約 3 秒
        while (r.total - r.chunks[0].length > 3 * sr && r.chunks.length > 1) {
          const c = r.chunks.shift(); r.first += c.length; r.total -= c.length;
        }
        if (Date.now() - r.startedAt > 90000 && !r.longWaitShown) {
          r.longWaitShown = true;
          setStatus('wait', '還在等待提示音…如果老師已經播完，請看「問題排除」');
        }
        return;
      }
    }
    const elapsed = (r.first + r.total - r.marker) / sr;
    const seg = P.segmentAt(elapsed);
    ui.seg.textContent = seg ? seg.label : '—';
    ui.prog.style.width = Math.min(100, (elapsed / P.RECORD_UNTIL) * 100) + '%';
    if (elapsed >= P.RECORD_UNTIL) finish(r);
  };

  const finish = (r) => {
    r.done = true;
    const info = r.session.info;
    closeMic();
    ui.cancel.classList.add('hidden');
    ui.live.classList.add('hidden');
    setStatus('wait', '錄音完成，分析中…');
    setTimeout(() => {
      const all = concat(r.chunks);
      const sr = r.sr;
      // 從提示音前 0.5 秒開始保留
      const from = Math.max(0, r.marker - r.first - Math.round(0.5 * sr));
      const x = all.slice(from);
      recordings[mode] = x;
      const res = A.analyzeRecording(x, sr);
      state.rounds[mode] = {
        when: new Date().toISOString(),
        context: DEV.standalone ? 'home-screen' : 'browser-tab',
        mic: info,
        analysis: res,
      };
      saveState();
      run = null;
      ui.start.classList.add('hidden');
      ui.redo.classList.remove('hidden');
      if (res.ok) setStatus('ok', '完成 ✓ 可以進行下一步');
      else setStatus('bad', res.error);
      renderRoundSummary(mode);
      renderPlayArea();
      renderResults();
    }, 50);
  };

  ui.start.onclick = begin;
  ui.redo.onclick = () => { ui.start.classList.remove('hidden'); begin(); };
  ui.cancel.onclick = () => {
    if (run) run.done = true;
    run = null;
    closeMic();
    ui.cancel.classList.add('hidden'); ui.live.classList.add('hidden');
    ui.start.disabled = false; ui.start.classList.remove('hidden');
    if (state.rounds[mode]) ui.redo.classList.remove('hidden');
    setStatus('', '已取消。');
  };

  if (state.rounds[mode]) {
    ui.start.classList.add('hidden');
    ui.redo.classList.remove('hidden');
    const ok = state.rounds[mode].analysis.ok;
    setStatus(ok ? 'ok' : 'bad', ok ? '這一回合已完成 ✓（錄音檔沒有保留，若需要請重做）' : state.rounds[mode].analysis.error);
    renderRoundSummary(mode);
  }
}

const VERDICT = {
  clean: ['ok', '沒發現被修改'],
  modified: ['bad', '有被修改的跡象'],
  unknown: ['unk', '無法判斷'],
};
const badge = (v) => `<span class="badge ${VERDICT[v][0]}">${VERDICT[v][1]}</span>`;
const okMark = (ok) => (ok === true ? '<span class="badge ok">✓</span>' : ok === false ? '<span class="badge bad">✗</span>' : '<span class="badge unk">?</span>');

function settingText(v) {
  if (v === true) return '開';
  if (v === false) return '關';
  return '未回報';
}

function renderRoundSummary(mode) {
  const r = state.rounds[mode];
  const ui = roundUI[mode];
  if (!r || !r.analysis.ok) { ui.summary.innerHTML = ''; return; }
  const a = r.analysis;
  const s = r.mic.settings || {};
  ui.summary.innerHTML = `
    <p>判定：${badge(a.verdict)}</p>
    <div class="table-wrap"><table>
      <tr><th>項目</th><th>測到</th><th>標準</th><th></th></tr>
      ${a.checks.map((c) => `<tr><td>${c.label}${c.note && c.ok !== true ? `<div class="small muted">${c.note}</div>` : ''}</td>
        <td class="num">${c.value}</td><td class="num small">${c.expect}</td><td>${okMark(c.ok)}</td></tr>`).join('')}
    </table></div>
    <p class="small muted">手機回報的設定：自動增益 ${settingText(s.autoGainControl)}、降噪 ${settingText(s.noiseSuppression)}、回音消除 ${settingText(s.echoCancellation)}；取樣率 ${r.mic.sampleRate} Hz</p>`;
}

// ---------------- 6 自由觀察 ----------------
function setupFree() {
  const st = $('freeStatus');
  const go = async (mode) => {
    st.className = 'status wait'; st.textContent = '正在開啟麥克風…';
    try {
      const s = await openMic(mode, null);
      startLiveSpectrum($('freeSpec'), s.analyser, mode === 'A' ? css('--spec-a') : css('--spec-b'));
      st.className = 'status ok'; st.textContent = `觀察中：${MODE_NAME[mode]}`;
      $('freeStop').disabled = false;
    } catch (err) {
      st.className = 'status bad'; st.textContent = micErrorText(err);
    }
  };
  $('freeA').onclick = () => go('A');
  $('freeB').onclick = () => go('B');
  $('freeStop').onclick = () => { closeMic(); $('freeStop').disabled = true; st.className = 'status'; st.textContent = '已停止。'; };
  const fn = $('freeNotes');
  fn.value = state.freeNotes || '';
  fn.oninput = () => { state.freeNotes = fn.value; saveState(); };
}

// ---------------- 7 重播 ----------------
const wavUrls = {};
function wavBlob(mode) {
  return new Blob([A.encodeWav(recordings[mode], state.rounds[mode].analysis.sr || ctx.sampleRate)], { type: 'audio/wav' });
}
function renderPlayArea() {
  const area = $('playArea');
  const parts = [];
  for (const mode of ['A', 'B']) {
    if (recordings[mode]) {
      if (wavUrls[mode]) URL.revokeObjectURL(wavUrls[mode]);
      wavUrls[mode] = URL.createObjectURL(wavBlob(mode));
      parts.push(`<p><strong>${MODE_NAME[mode]}</strong></p><audio controls preload="metadata" src="${wavUrls[mode]}" style="width:100%"></audio>`);
    } else if (state.rounds[mode]) {
      parts.push(`<p class="muted small">${MODE_NAME[mode]}：網頁重新開啟過，錄音沒有保留。</p>`);
    }
  }
  area.innerHTML = parts.length ? parts.join('') : '<p class="muted">完成 A、B 回合後，這裡會出現錄音。</p>';
  $('saveWavA').disabled = !recordings.A;
  $('saveWavB').disabled = !recordings.B;
}

function setupPractical() {
  for (const [id, key] of [['chkPlayA', 'playA'], ['chkPlayB', 'playB'], ['chkSave', 'save']]) {
    const el = $(id);
    el.checked = !!state.practical[key];
    el.onchange = () => { state.practical[key] = el.checked; saveState(); };
  }
}

// ---------------- 8 結果 ----------------
function renderResults() {
  const area = $('resultArea');
  const ra = state.rounds.A, rb = state.rounds.B;
  $('saveJson').disabled = !(ra || rb);
  if (!(ra && ra.analysis.ok) && !(rb && rb.analysis.ok)) {
    area.innerHTML = '<p class="muted">完成 A、B 兩個回合後，這裡會出現比較結果。</p>';
    return;
  }
  const aa = ra && ra.analysis.ok ? ra.analysis : null;
  const bb = rb && rb.analysis.ok ? rb.analysis : null;

  let headline = '';
  if (aa && bb) {
    if (bb.verdict === 'clean' && aa.verdict === 'modified') headline = '<div class="note ok"><strong>B 模式成功關掉了美化功能。</strong>A 模式的聲音有被修改，B 模式沒有。</div>';
    else if (bb.verdict === 'clean' && aa.verdict === 'clean') headline = '<div class="note ok"><strong>兩種模式都沒發現被修改。</strong>這支手機的預設收音就很忠實。</div>';
    else if (bb.verdict === 'modified') headline = '<div class="note bad"><strong>B 模式仍有被修改的跡象。</strong>這支手機可能不聽網頁的要求，這正是我們要找的重要資料。</div>';
    else headline = '<div class="note warn"><strong>無法判斷。</strong>訊號太小或太吵，建議請老師調整音量後重做。</div>';
  } else {
    headline = '<div class="note warn">只完成一個回合，請完成另一個回合再上傳。</div>';
  }

  const ids = (aa || bb).checks.map((c) => c.id);
  const findC = (an, id) => (an ? an.checks.find((c) => c.id === id) : null);
  const rowsHtml = ids.map((id) => {
    const ca = findC(aa, id), cb = findC(bb, id);
    const lab = (ca || cb).label;
    const cell = (c) => (c ? `${c.value} ${okMark(c.ok)}` : '—');
    return `<tr><td>${lab}</td><td class="num">${cell(ca)}</td><td class="num">${cell(cb)}</td></tr>`;
  }).join('');
  const sa = ra ? ra.mic.settings || {} : {}, sb = rb ? rb.mic.settings || {} : {};
  const setRow = (k, lab) => `<tr><td>手機回報：${lab}</td><td>${ra ? settingText(sa[k]) : '—'}</td><td>${rb ? settingText(sb[k]) : '—'}</td></tr>`;

  area.innerHTML = `
    ${headline}
    <dl class="kv small">
      <dt>組別</dt><dd>${esc(state.info.group || '（未填）')}</dd>
      <dt>手機</dt><dd>${esc(state.info.model || '（未填）')}，${esc(DEV.os)} ${esc(DEV.osVersion)}</dd>
      <dt>瀏覽器</dt><dd>${esc(DEV.browser)}${DEV.standalone ? '（主畫面）' : ''}</dd>
    </dl>
    <div class="table-wrap"><table>
      <tr><th>項目</th><th>A 預設</th><th>B 關閉美化</th></tr>
      <tr><td><strong>判定</strong></td><td>${aa ? badge(aa.verdict) : '—'}</td><td>${bb ? badge(bb.verdict) : '—'}</td></tr>
      ${rowsHtml}
      ${setRow('autoGainControl', '自動增益')}
      ${setRow('noiseSuppression', '降噪')}
      ${setRow('echoCancellation', '回音消除')}
    </table></div>
    <h3>② 複合音：各泛音相對於基頻的強度（橫軸單位 Hz）</h3>
    <div class="legend"><span><i style="background:${css('--spec-a')}"></i>A 預設</span><span><i style="background:${css('--spec-b')}"></i>B 關閉美化</span></div>
    <canvas class="chart" id="harmChart"></canvas>
    <p class="small muted">筆電喇叭本身的音色也會影響這張圖，所以重點是 <strong>A、B 兩條線差多少</strong>。</p>
    <h3>④ 掃頻：各頻率的收音強度（以 1000 Hz 為 0 dB）</h3>
    <canvas class="chart" id="sweepChart"></canvas>`;

  const series = [];
  if (aa) series.push({ color: css('--spec-a'), an: aa });
  if (bb) series.push({ color: css('--spec-b'), an: bb });
  drawLineChart($('harmChart'), {
    xs: [1, 2, 3, 4, 5, 6, 7, 8], xLabel: (x) => `${x * 440}`, logX: false,
    series: series.map((s) => ({ color: s.color, ys: s.an.metrics.harmRel })), yUnit: 'dB',
  });
  drawLineChart($('sweepChart'), {
    xs: A.THIRD_OCT, xLabel: (f) => (f >= 1000 ? `${f / 1000}k` : `${f}`), logX: true,
    series: series.map((s) => {
      const ref = s.an.metrics.sweep.find((b) => b.f === 1000).db;
      return { color: s.color, ys: s.an.metrics.sweep.map((b) => (b.db === null || ref === null ? null : b.db - ref)) };
    }),
    yUnit: 'dB',
  });
}

function drawLineChart(canvas, { xs, xLabel, logX, series, yUnit }) {
  const { w, h, dpr } = fitCanvas(canvas);
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, w, h);
  const all = series.flatMap((s) => s.ys.filter((v) => v !== null && isFinite(v)));
  if (!all.length) return;
  let lo = Math.floor(Math.min(...all) / 5) * 5 - 5, hi = Math.ceil(Math.max(...all) / 5) * 5 + 5;
  if (hi - lo < 20) { const mid = (hi + lo) / 2; lo = mid - 10; hi = mid + 10; }
  const padL = 44 * dpr, padR = 10 * dpr, padT = 10 * dpr, padB = 24 * dpr;
  const xv = (i) => {
    const t = logX ? Math.log(xs[i] / xs[0]) / Math.log(xs[xs.length - 1] / xs[0]) : i / (xs.length - 1);
    return padL + t * (w - padL - padR);
  };
  const yv = (v) => padT + ((hi - v) / (hi - lo)) * (h - padT - padB);
  g.font = `${11 * dpr}px sans-serif`;
  g.strokeStyle = css('--line'); g.fillStyle = css('--muted'); g.lineWidth = 1;
  const step = (hi - lo) > 40 ? 10 : 5;
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    const y = yv(v);
    g.beginPath(); g.moveTo(padL, y); g.lineTo(w - padR, y); g.stroke();
    g.fillText(`${v} ${yUnit}`, 2 * dpr, y + 4 * dpr);
  }
  const every = xs.length > 10 ? 3 : 1;
  xs.forEach((x, i) => {
    if (i % every !== 0) return;
    const t = xLabel(x), tw = g.measureText(t).width;
    g.fillText(t, Math.min(Math.max(padL - tw / 2, xv(i) - tw / 2), w - tw - 2 * dpr), h - 6 * dpr);
  });
  for (const s of series) {
    g.strokeStyle = s.color; g.fillStyle = s.color; g.lineWidth = 2.2 * dpr;
    g.beginPath();
    let pen = false;
    s.ys.forEach((v, i) => {
      if (v === null || !isFinite(v)) { pen = false; return; }
      if (!pen) { g.moveTo(xv(i), yv(v)); pen = true; } else g.lineTo(xv(i), yv(v));
    });
    g.stroke();
    s.ys.forEach((v, i) => { if (v !== null && isFinite(v)) { g.beginPath(); g.arc(xv(i), yv(v), 3 * dpr, 0, 7); g.fill(); } });
  }
}

// ---------------- 存檔 ----------------
function baseName() {
  const g = String(state.info.group || '0').padStart(2, '0');
  const m = (state.info.model || DEV.os).replace(/[^\w一-鿿.-]+/g, '');
  const c = DEV.standalone ? 'home' : 'tab';
  const t = new Date();
  const stamp = `${t.getMonth() + 1}${String(t.getDate()).padStart(2, '0')}-${String(t.getHours()).padStart(2, '0')}${String(t.getMinutes()).padStart(2, '0')}`;
  return `G${g}_${m}_${DEV.os}${DEV.osVersion.split('.')[0] || ''}_${c}_${stamp}`;
}

function buildResultJson() {
  return {
    schema: 'mic-check-result', appVersion: APP_VERSION, programVersion: P.PROGRAM_VERSION,
    createdAt: new Date().toISOString(),
    group: state.info.group || '', model: state.info.model || '', browserSelected: state.info.browser || '',
    device: DEV,
    rounds: state.rounds,
    practical: state.practical,
    notes: state.notes, freeNotes: state.freeNotes,
  };
}

async function deliverFile(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function setupSaving() {
  $('saveJson').onclick = () => {
    const blob = new Blob([JSON.stringify(buildResultJson(), null, 1)], { type: 'application/json' });
    deliverFile(blob, `${baseName()}_result.json`);
  };
  $('saveWavA').onclick = () => recordings.A && deliverFile(wavBlob('A'), `${baseName()}_A.wav`);
  $('saveWavB').onclick = () => recordings.B && deliverFile(wavBlob('B'), `${baseName()}_B.wav`);
  $('uploadLink').href = UPLOAD_URL;
  $('resetAll').onclick = () => {
    if (!confirm('確定要清除這支手機上的所有紀錄嗎？')) return;
    try { localStorage.removeItem(STORE_KEY); } catch (e) { /* 忽略 */ }
    location.reload();
  };
  const n = $('notes');
  n.value = state.notes || '';
  n.oninput = () => { state.notes = n.value; saveState(); };
}

// ---------------- 1 基本資料 ----------------
function setupInfo() {
  for (const k of ['group', 'model', 'browser']) {
    const el = $(k);
    el.value = state.info[k] || '';
    if (k === 'browser' && !el.value) {
      const map = { Safari: 'Safari', Chrome: 'Chrome', 'Chrome（iOS）': 'Chrome', 'LINE 內建': 'LINE 內建瀏覽器' };
      if (map[DEV.browser]) el.value = map[DEV.browser];
    }
    const save = () => { state.info[k] = el.value.trim(); saveState(); };
    el.oninput = save; el.onchange = save;
    if (k === 'browser' && el.value && !state.info.browser) save();
  }
}

function updateNav() {
  const done = {
    info: !!(state.info.group && state.info.model),
    mic: !!state.micChecked,
    A: !!(state.rounds.A && state.rounds.A.analysis.ok),
    B: !!(state.rounds.B && state.rounds.B.analysis.ok),
    play: !!(state.practical.playA || state.practical.playB),
    result: false,
  };
  document.querySelectorAll('#nav a[data-step]').forEach((a) => a.classList.toggle('done', !!done[a.dataset.step]));
}

// ---------------- 啟動 ----------------
renderDeviceInfo();
setupInfo();
setupMicCheck();
setupRound('A');
setupRound('B');
setupFree();
setupPractical();
setupSaving();
renderPlayArea();
renderResults();
updateNav();
let resizeT;
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(renderResults, 200); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && session) {
    // 切到背景時 iOS 會中斷麥克風，直接關閉並提示
    closeMic();
    for (const m of ['A', 'B']) {
      const ui = roundUI[m];
      if (ui && !ui.live.classList.contains('hidden')) {
        ui.live.classList.add('hidden'); ui.cancel.classList.add('hidden');
        ui.start.disabled = false; ui.start.classList.remove('hidden');
        ui.status.className = 'status bad'; ui.status.textContent = '網頁被切到背景，錄音中斷了。請重新按「開始等待訊號」。';
      }
    }
  }
});
