// Corre en el hilo de audio. Junta bloques de 128 muestras hasta tener 20 ms
// (960 muestras a 48 kHz) por canal y los manda al documento offscreen.

const FRAMES_PER_PACKET = 960;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.left = new Float32Array(FRAMES_PER_PACKET);
    this.right = new Float32Array(FRAMES_PER_PACKET);
    this.offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const l = input[0];
    const r = input[1] ?? input[0];
    const blockSize = l ? l.length : 128;

    let read = 0;
    while (read < blockSize) {
      const n = Math.min(blockSize - read, FRAMES_PER_PACKET - this.offset);
      if (l) {
        this.left.set(l.subarray(read, read + n), this.offset);
        this.right.set(r.subarray(read, read + n), this.offset);
      } else {
        // Sin entrada todavia: rellenar con silencio para no cortar el flujo
        this.left.fill(0, this.offset, this.offset + n);
        this.right.fill(0, this.offset, this.offset + n);
      }
      this.offset += n;
      read += n;

      if (this.offset === FRAMES_PER_PACKET) {
        this.port.postMessage({ left: this.left, right: this.right }, [this.left.buffer, this.right.buffer]);
        this.left = new Float32Array(FRAMES_PER_PACKET);
        this.right = new Float32Array(FRAMES_PER_PACKET);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
