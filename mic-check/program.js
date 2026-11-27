// 測試音訊程序的定義：老師端用它產生聲音，學生端用它對時間、做分析。
// 所有時間（秒）都以「開頭提示音」的起點為 0。

export const PROGRAM_VERSION = 1;

// 音檔開頭先留一段靜音，避免播放器剛啟動時吃掉聲音
export const LEAD_IN = 1.0;

export const MARKER = { start: 0.0, end: 0.5, freq: 2000, dbfs: -12 };

export const STEP_FREQ = 1000;
export const STEPS = [
  { start: 1.5, end: 4.5, dbfs: -12 },
  { start: 4.5, end: 7.5, dbfs: -22 },
  { start: 7.5, end: 10.5, dbfs: -32 },
];

export const SILENCE = { start: 10.5, end: 14.5 };

// 複合音：基頻 440 Hz，第 n 諧波振幅 = gain / n
export const HARM = { start: 14.5, end: 20.5, f0: 440, n: 8, gain: 0.25 };

export const SWEEP = { start: 21.5, end: 27.5, f1: 200, f2: 12000, dbfs: -12 };

export const PROGRAM_END = 28.0;
export const TOTAL_DURATION = LEAD_IN + PROGRAM_END + 0.5;

// 學生端在偵測到提示音後，要錄到這個時間點
export const RECORD_UNTIL = PROGRAM_END + 0.3;

export const SEGMENTS = [
  { start: 0.0, end: 0.5, key: 'marker', label: '開頭提示音（嗶）' },
  { start: 0.5, end: 1.5, key: 'gap', label: '安靜' },
  { start: 1.5, end: 10.5, key: 'steps', label: '① 音量階梯：1000 Hz，每 3 秒小 10 dB' },
  { start: 10.5, end: 14.5, key: 'silence', label: '③ 安靜段：請全班保持安靜' },
  { start: 14.5, end: 20.5, key: 'harm', label: '② 複合音：440 Hz 加 8 個泛音' },
  { start: 20.5, end: 21.5, key: 'gap', label: '安靜' },
  { start: 21.5, end: 27.5, key: 'sweep', label: '④ 掃頻：200 Hz → 12000 Hz' },
  { start: 27.5, end: 28.0, key: 'end', label: '結束' },
];

export function segmentAt(t) {
  for (const s of SEGMENTS) if (t >= s.start && t < s.end) return s;
  return null;
}

export const dbToAmp = (db) => Math.pow(10, db / 20);

// 固定的泛音相位（降低波峰值，避免喇叭削波）
export const HARM_PHASES = [0, 1.7, 0.4, 2.9, 1.1, 4.2, 2.3, 5.5];

export function sweepFreqAt(t) {
  // t：從掃頻開始算起的秒數
  const T = SWEEP.end - SWEEP.start;
  return SWEEP.f1 * Math.pow(SWEEP.f2 / SWEEP.f1, t / T);
}

function fade(t, start, end, ramp) {
  if (t < start || t >= end) return 0;
  const a = Math.min(1, (t - start) / ramp);
  const b = Math.min(1, (end - t) / ramp);
  return Math.min(a, b);
}

// 產生整段測試音（單聲道 Float32Array）
export function generateProgram(sampleRate) {
  const n = Math.ceil(TOTAL_DURATION * sampleRate);
  const out = new Float32Array(n);
  const TWO_PI = 2 * Math.PI;
  const mAmp = dbToAmp(MARKER.dbfs);
  const sweepAmp = dbToAmp(SWEEP.dbfs);
  const sweepT = SWEEP.end - SWEEP.start;
  const k = SWEEP.f2 / SWEEP.f1;
  const lnk = Math.log(k);
  const stepAmps = STEPS.map((s) => dbToAmp(s.dbfs));
  const xr = 0.005; // 音量切換的交叉漸變時間

  for (let i = 0; i < n; i++) {
    const t = i / sampleRate - LEAD_IN;
    let v = 0;

    if (t >= MARKER.start && t < MARKER.end) {
      v += mAmp * fade(t, MARKER.start, MARKER.end, 0.01) * Math.sin(TWO_PI * MARKER.freq * t);
    }

    const s0 = STEPS[0].start, s1 = STEPS[STEPS.length - 1].end;
    if (t >= s0 && t < s1) {
      // 分段振幅，在切換點附近線性漸變（相位連續）
      let amp = stepAmps[0];
      for (let j = 0; j < STEPS.length; j++) {
        if (t >= STEPS[j].start) amp = stepAmps[j];
      }
      for (let j = 1; j < STEPS.length; j++) {
        const b = STEPS[j].start;
        if (t >= b - xr && t < b + xr) {
          const w = (t - (b - xr)) / (2 * xr);
          amp = stepAmps[j - 1] * (1 - w) + stepAmps[j] * w;
        }
      }
      v += amp * fade(t, s0, s1, 0.01) * Math.sin(TWO_PI * STEP_FREQ * t);
    }

    if (t >= HARM.start && t < HARM.end) {
      const env = fade(t, HARM.start, HARM.end, 0.01);
      let h = 0;
      for (let m = 1; m <= HARM.n; m++) {
        h += (HARM.gain / m) * Math.sin(TWO_PI * m * HARM.f0 * t + HARM_PHASES[m - 1]);
      }
      v += env * h;
    }

    if (t >= SWEEP.start && t < SWEEP.end) {
      const ts = t - SWEEP.start;
      const phase = (TWO_PI * SWEEP.f1 * sweepT / lnk) * (Math.pow(k, ts / sweepT) - 1);
      v += sweepAmp * fade(t, SWEEP.start, SWEEP.end, 0.02) * Math.sin(phase);
    }

    out[i] = v;
  }
  return out;
}
