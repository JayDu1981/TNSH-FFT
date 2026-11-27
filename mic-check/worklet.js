// 把麥克風的原始樣本一段一段送回主程式
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 4096;
    this.buf = new Float32Array(this.size);
    this.fill = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      let i = 0;
      while (i < ch.length) {
        const n = Math.min(ch.length - i, this.size - this.fill);
        this.buf.set(ch.subarray(i, i + n), this.fill);
        this.fill += n; i += n;
        if (this.fill === this.size) {
          this.port.postMessage(this.buf);
          this.buf = new Float32Array(this.size);
          this.fill = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
