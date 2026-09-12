class DootCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = [];
    this.position = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (output) output.fill(0);
    if (!input) return true;
    const step = sampleRate / 8000;
    let energy = 0;
    for (let i = 0; i < input.length; i += 1) energy += input[i] * input[i];
    while (this.position < input.length) {
      const before = Math.floor(this.position);
      const after = Math.min(input.length - 1, before + 1);
      const sample = input[before] + (input[after] - input[before]) * (this.position - before);
      this.samples.push(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))));
      this.position += step;
    }
    this.position -= input.length;
    if (this.samples.length >= 640) {
      const frame = Int16Array.from(this.samples.splice(0, 640));
      this.port.postMessage({ pcm: frame.buffer, rms: Math.sqrt(energy / input.length) }, [frame.buffer]);
    }
    return true;
  }
}

registerProcessor("doot-capture", DootCapture);
