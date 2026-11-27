// 純運算模組：FFT、提示音偵測、各項指標計算、WAV 編碼。
// 不碰 DOM，方便在瀏覽器與 Node 中共用與測試。
import * as P from './program.js';

// ---------- FFT ----------
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

const hannCache = new Map();
function hann(n) {
  if (!hannCache.has(n)) {
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    hannCache.set(n, w);
  }
  return hannCache.get(n);
}

// 單邊功率頻譜：對一個振幅 A 的正弦波，把峰值附近幾格加起來 ≈ A²/2
function framePower(x, start, N, out) {
  const w = hann(N);
  const re = new Float64Array(N), im = new Float64Array(N);
  let sw2 = 0;
  for (let i = 0; i < N; i++) {
    re[i] = (x[start + i] || 0) * w[i];
    sw2 += w[i] * w[i];
  }
  fft(re, im);
  const norm = 2 / (N * sw2);
  for (let k = 0; k <= N / 2; k++) out[k] += (re[k] * re[k] + im[k] * im[k]) * norm;
}

// Welch 平均功率頻譜，取 [t0, t1) 秒
export function welch(x, sr, t0, t1, N = 8192) {
  const a = Math.max(0, Math.round(t0 * sr));
  const b = Math.min(x.length, Math.round(t1 * sr));
  const psd = new Float64Array(N / 2 + 1);
  const hop = N / 2;
  let count = 0;
  if (b - a >= N) {
    for (let s = a; s + N <= b; s += hop) { framePower(x, s, N, psd); count++; }
  } else {
    // 區段太短：縮小 N
    let n2 = 1024;
    while (n2 * 2 <= b - a) n2 *= 2;
    return welch(x, sr, t0, t1, n2);
  }
  for (let k = 0; k < psd.length; k++) psd[k] /= count;
  return { psd, df: sr / N, N };
}

const powToDb = (p) => 10 * Math.log10(Math.max(p, 1e-20) / 0.5); // 相對滿刻度正弦波

// 某頻率的單音音量（dBFS）
export function toneLevel(spec, f, searchFrac = 0.03, half = 4) {
  const { psd, df } = spec;
  const c = Math.round(f / df);
  const r = Math.max(3, Math.round((f * searchFrac) / df));
  let pk = c, pv = -1;
  for (let k = Math.max(1, c - r); k <= Math.min(psd.length - 2, c + r); k++) {
    if (psd[k] > pv) { pv = psd[k]; pk = k; }
  }
  let sum = 0;
  for (let k = Math.max(0, pk - half); k <= Math.min(psd.length - 1, pk + half); k++) sum += psd[k];
  // 拋物線內插求精確頻率
  const y0 = Math.log(psd[pk - 1] + 1e-30), y1 = Math.log(psd[pk] + 1e-30), y2 = Math.log(psd[pk + 1] + 1e-30);
  const d = (y0 - 2 * y1 + y2) === 0 ? 0 : (0.5 * (y0 - y2)) / (y0 - 2 * y1 + y2);
  return { db: powToDb(sum), freq: (pk + d) * df };
}

export function bandLevel(spec, f1, f2) {
  const { psd, df } = spec;
  let sum = 0;
  for (let k = Math.ceil(f1 / df); k <= Math.min(psd.length - 1, Math.floor(f2 / df)); k++) sum += psd[k];
  return powToDb(sum);
}

// ---------- 提示音偵測（可串流） ----------
export class MarkerDetector {
  constructor(sr) {
    this.sr = sr;
    this.block = Math.round(sr * 0.02); // 20 ms 一格
    this.buf = new Float32Array(this.block);
    this.fill = 0;
    this.pos = 0; // 已處理樣本數（絕對）
    this.run = 0;
    this.runStart = 0;
    this.found = null;
    const w = (2 * Math.PI * P.MARKER.freq) / sr;
    this.coef = 2 * Math.cos(w);
    this.cw = Math.cos(w); this.sw = Math.sin(w);
  }
  // 回傳提示音起點的絕對樣本索引（找到後固定不變），找不到則回傳 null
  push(samples) {
    if (this.found !== null) return this.found;
    for (let i = 0; i < samples.length; i++) {
      this.buf[this.fill++] = samples[i];
      if (this.fill === this.block) {
        this._processBlock(this.pos);
        this.pos += this.block;
        this.fill = 0;
        if (this.found !== null) return this.found;
      }
    }
    return null;
  }
  _processBlock(blockStart) {
    const N = this.block, x = this.buf;
    let s1 = 0, s2 = 0, ms = 0;
    for (let i = 0; i < N; i++) {
      const s0 = x[i] + this.coef * s1 - s2;
      s2 = s1; s1 = s0;
      ms += x[i] * x[i];
    }
    ms /= N;
    const re = s1 - s2 * this.cw, im = s2 * this.sw;
    const tonal = (2 * (re * re + im * im)) / (N * N); // 純正弦波時 ≈ ms
    const ratio = ms > 0 ? tonal / ms : 0;
    const ok = ratio > 0.5 && ms > 1e-9; // 約 -90 dBFS 以上
    if (ok) {
      if (this.run === 0) this.runStart = blockStart;
      this.run++;
      if (this.run >= 10) this.found = this.runStart; // 連續 200 ms
    } else {
      this.run = 0;
    }
  }
}

export function findMarker(x, sr) {
  const d = new MarkerDetector(sr);
  const s = d.push(x);
  return s === null ? null : s / sr;
}

// ---------- 掃頻響應 ----------
export const THIRD_OCT = [200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000];

function sweepResponse(x, sr, t0) {
  const N = 2048, hop = 512;
  const a = Math.round((t0 + P.SWEEP.start + 0.1) * sr);
  const b = Math.round((t0 + P.SWEEP.end - 0.1) * sr);
  const acc = THIRD_OCT.map(() => ({ p: 0, n: 0 }));
  const tmp = new Float64Array(N / 2 + 1);
  const df = sr / N;
  for (let s = a; s + N <= b && s + N <= x.length; s += hop) {
    tmp.fill(0);
    framePower(x, s, N, tmp);
    const tc = (s + N / 2) / sr - t0 - P.SWEEP.start;
    const f = P.sweepFreqAt(tc);
    const lo = Math.max(1, Math.floor(f / 1.1 / df)), hi = Math.min(tmp.length - 3, Math.ceil((f * 1.1) / df));
    let pk = lo, pv = -1;
    for (let k = lo; k <= hi; k++) if (tmp[k] > pv) { pv = tmp[k]; pk = k; }
    let sum = 0;
    for (let k = pk - 2; k <= pk + 2; k++) sum += tmp[k];
    let bi = 0, bd = Infinity;
    THIRD_OCT.forEach((c, i) => { const d = Math.abs(Math.log(f / c)); if (d < bd) { bd = d; bi = i; } });
    if (bd < Math.log(2) / 6 + 1e-9) { acc[bi].p += sum; acc[bi].n++; }
  }
  return THIRD_OCT.map((f, i) => ({ f, db: acc[i].n ? round1(powToDb(acc[i].p / acc[i].n)) : null }));
}

const round1 = (v) => (v === null || !isFinite(v) ? null : Math.round(v * 10) / 10);

// ---------- 判斷門檻 ----------
export const THRESH = {
  minSnr: 25,          // 1 kHz 訊號比底噪大多少 dB 才算夠清楚
  stepTol: 1.5,        // 音量階梯允許誤差（應為 10 dB）
  agcTol: 1.5,         // 音量切換後自己回彈的允許量
  noiseTol: 3,         // 安靜段底噪變化
  decayTol: 1.5,       // 持續音的衰減
  clip: 0.98,
};

// ---------- 主分析 ----------
export function analyzeRecording(x, sr) {
  const t0 = findMarker(x, sr);
  if (t0 === null) return { ok: false, error: '找不到開頭提示音（2000 Hz 的嗶聲）。請確認喇叭音量夠大、手機沒有離太遠。' };
  if (x.length / sr < t0 + P.PROGRAM_END - 0.2) return { ok: false, error: '錄音不完整：還沒錄完整段測試音就停止了。' };

  const W = (a, b, N) => welch(x, sr, t0 + a, t0 + b, N);
  let maxAbs = 0;
  const s = Math.round(t0 * sr), e = Math.min(x.length, Math.round((t0 + P.PROGRAM_END) * sr));
  for (let i = s; i < e; i++) { const v = Math.abs(x[i]); if (v > maxAbs) maxAbs = v; }

  const F = P.STEP_FREQ;
  const lv = (a, b) => toneLevel(W(a, b), F).db;
  const L1i = lv(1.55, 1.95), L1 = lv(2.6, 4.4);
  const L2i = lv(4.55, 4.95), L2 = lv(6.1, 7.4);
  const L3i = lv(7.55, 7.95), L3 = lv(9.1, 10.4);

  const silE = W(11.0, 12.0), silL = W(13.0, 14.3);
  const noiseEarly = bandLevel(silE, 100, 10000);
  const noiseLate = bandLevel(silL, 100, 10000);
  const noise1k = toneLevel(silL, F).db;

  const harmAll = W(15.0, 20.3);
  const harmE = W(15.0, 16.0), harmL = W(19.2, 20.3);
  const H = [], HE = [], HL = [], Hf = [];
  for (let m = 1; m <= P.HARM.n; m++) {
    const r = toneLevel(harmAll, m * P.HARM.f0, 0.01);
    H.push(r.db); Hf.push(r.freq);
    HE.push(toneLevel(harmE, m * P.HARM.f0, 0.01).db);
    HL.push(toneLevel(harmL, m * P.HARM.f0, 0.01).db);
  }
  const sumDb = (arr) => powToDb(arr.reduce((acc, d) => acc + 0.5 * Math.pow(10, d / 10), 0));
  const harmDecay = sumDb(HL) - sumDb(HE);

  const m = {
    markerAt: round1(t0),
    maxAbs: Math.round(maxAbs * 1000) / 1000,
    L1: round1(L1), L2: round1(L2), L3: round1(L3),
    L1i: round1(L1i), L2i: round1(L2i), L3i: round1(L3i),
    d12: round1(L1 - L2), d23: round1(L2 - L3),
    agc1: round1(L1 - L1i), agc2: round1(L2 - L2i), agc3: round1(L3 - L3i),
    noise1k: round1(noise1k),
    snr: round1(L1 - noise1k),
    snr3: round1(L3 - noise1k),
    noiseEarly: round1(noiseEarly), noiseLate: round1(noiseLate),
    noiseRise: round1(noiseLate - noiseEarly),
    harmDb: H.map(round1),
    harmRel: H.map((d) => round1(d - H[0])),
    harmFreq: Hf.map((f) => Math.round(f * 10) / 10),
    harmDecay: round1(harmDecay),
    sweep: sweepResponse(x, sr, t0),
  };

  const T = THRESH;
  const checks = [];
  const add = (id, label, value, ok, expect, note) => checks.push({ id, label, value, ok, expect, note });
  const snrOk = m.snr >= T.minSnr;
  add('snr', '訊號夠清楚', `${m.snr} dB`, snrOk ? true : null, `≥ ${T.minSnr} dB`,
    snrOk ? '' : '訊號太小或環境太吵，其他項目可能不準。請把喇叭音量調大、手機靠近一點。');
  add('clip', '沒有爆音（削波）', `${m.maxAbs}`, m.maxAbs < T.clip, `< ${T.clip}`,
    m.maxAbs < T.clip ? '' : '聲音太大，手機收音已經爆掉。請把喇叭音量調小或手機離遠一點。');
  add('step1', '音量階梯 第1→2段', `${m.d12} dB`, Math.abs(m.d12 - 10) <= T.stepTol, `10 ± ${T.stepTol} dB`, '');
  const snr3Ok = m.snr3 >= 10;
  add('step2', '音量階梯 第2→3段', `${m.d23} dB`, snr3Ok ? Math.abs(m.d23 - 10) <= T.stepTol : null, `10 ± ${T.stepTol} dB`,
    snr3Ok ? '' : '第 3 段太小聲，無法判斷。');
  const agcMax = Math.max(Math.abs(m.agc1), Math.abs(m.agc2), snr3Ok ? Math.abs(m.agc3) : 0);
  add('agc', '音量不會自己慢慢變', `${round1(agcMax)} dB`, agcMax <= T.agcTol, `≤ ${T.agcTol} dB`, '');
  add('noise', '安靜段底噪穩定', `${m.noiseRise} dB`, Math.abs(m.noiseRise) <= T.noiseTol, `± ${T.noiseTol} dB`,
    '如果安靜段有人說話或有雜音，這項會不準。');
  add('decay', '持續音不會被壓低', `${m.harmDecay} dB`, Math.abs(m.harmDecay) <= T.decayTol, `± ${T.decayTol} dB`, '');

  const judged = checks.filter((c) => c.ok !== null && c.id !== 'snr');
  let verdict;
  if (!snrOk) verdict = 'unknown';
  else if (judged.some((c) => c.ok === false)) verdict = 'modified';
  else verdict = 'clean';

  return { ok: true, sr, metrics: m, checks, verdict };
}

// ---------- WAV ----------
export function encodeWav(x, sr) {
  const n = x.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, x[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

export function decodeWav(buf) {
  const v = new DataView(buf);
  let off = 12, sr = 48000, bits = 16, ch = 1, dataOff = -1, dataLen = 0;
  while (off + 8 <= v.byteLength) {
    const id = String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));
    const len = v.getUint32(off + 4, true);
    if (id === 'fmt ') { ch = v.getUint16(off + 10, true); sr = v.getUint32(off + 12, true); bits = v.getUint16(off + 22, true); }
    if (id === 'data') { dataOff = off + 8; dataLen = len; break; }
    off += 8 + len;
  }
  const n = Math.floor(dataLen / (bits / 8) / ch);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = dataOff + i * ch * (bits / 8);
    x[i] = bits === 16 ? v.getInt16(p, true) / 32768 : v.getFloat32(p, true);
  }
  return { x, sr };
}
