/**
 * NoteAnalyzer: constant-Q style per-note energy analysis.
 *
 * Instead of a single linear FFT (whose fixed bin width is far too coarse to
 * separate low semitones), this runs one Goertzel filter per note with a
 * per-note window length N = Q * sampleRate / f. Every note therefore observes
 * the same number of cycles (~Q), so low notes use long windows (precise but
 * laggy) while high notes use short windows (fast and cheap).
 *
 * Exposes window.NoteAnalyzer with:
 *   new NoteAnalyzer(sampleRate, { minMidi, maxMidi, q })
 *   .bufferSize   power-of-two time-domain buffer length the caller must feed
 *   .noteCount    number of notes (maxMidi - minMidi + 1)
 *   .frequencies  Float32Array of per-note centre frequencies (Hz)
 *   .analyze(timeData, out)  fill out[i] with per-note amplitude in [0, 1]
 */
(function () {
  "use strict";

  const TWO_PI = Math.PI * 2;
  const SEMITONE_RATIO = Math.pow(2, 1 / 12);
  // Q for one bin per semitone: bandwidth = f * (2^(1/12) - 1).
  const DEFAULT_Q = 1 / (SEMITONE_RATIO - 1); // ~16.82

  const A4_FREQ = 440;
  const A4_MIDI = 69;

  // AnalyserNode.getFloatTimeDomainData is capped at fftSize 32768; keep a
  // sane floor so high sample rates still get a usable buffer.
  const MAX_BUFFER = 32768;
  const MIN_BUFFER = 2048;

  function nextPow2(n) {
    let p = MIN_BUFFER;
    while (p < n && p < MAX_BUFFER) p *= 2;
    return Math.min(p, MAX_BUFFER);
  }

  class NoteAnalyzer {
    constructor(sampleRate, options = {}) {
      this.sampleRate = sampleRate;
      this.minMidi = options.minMidi != null ? options.minMidi : 36;  // C2
      this.maxMidi = options.maxMidi != null ? options.maxMidi : 107; // B7
      this.q = options.q != null ? options.q : DEFAULT_Q;
      this.noteCount = this.maxMidi - this.minMidi + 1;

      this.frequencies = new Float32Array(this.noteCount);
      const idealWindows = new Int32Array(this.noteCount);
      let maxWindow = 0;
      for (let i = 0; i < this.noteCount; i++) {
        const midi = this.minMidi + i;
        const freq = A4_FREQ * Math.pow(2, (midi - A4_MIDI) / 12);
        this.frequencies[i] = freq;
        const n = Math.max(1, Math.round((this.q * sampleRate) / freq));
        idealWindows[i] = n;
        if (n > maxWindow) maxWindow = n;
      }

      // Buffer must hold the longest (lowest-note) window; cap at the analyser
      // limit. Any note whose ideal window exceeds the cap is clamped, which
      // only happens for very low notes at very high sample rates.
      this.bufferSize = nextPow2(maxWindow);

      this.windowLengths = new Int32Array(this.noteCount);
      this.coeffs = new Float32Array(this.noteCount);
      this.windowSums = new Float32Array(this.noteCount);
      /** @type {Float32Array[]} per-note Hann window (precomputed) */
      this.windows = new Array(this.noteCount);

      for (let i = 0; i < this.noteCount; i++) {
        const n = Math.min(idealWindows[i], this.bufferSize);
        this.windowLengths[i] = n;

        const omega = (TWO_PI * this.frequencies[i]) / sampleRate;
        this.coeffs[i] = 2 * Math.cos(omega);

        const win = new Float32Array(n);
        const denom = n > 1 ? n - 1 : 1;
        let sum = 0;
        for (let k = 0; k < n; k++) {
          const w = 0.5 - 0.5 * Math.cos((TWO_PI * k) / denom);
          win[k] = w;
          sum += w;
        }
        this.windows[i] = win;
        this.windowSums[i] = sum > 0 ? sum : 1;
      }
    }

    /**
     * Run the filterbank over the most recent samples of a time-domain buffer.
     * Reads the tail (latest N samples) per note for minimal latency.
     * @param {Float32Array} timeData length should equal this.bufferSize
     * @param {Float32Array} out destination, length >= noteCount
     */
    analyze(timeData, out) {
      const total = timeData.length;
      for (let i = 0; i < this.noteCount; i++) {
        const n = this.windowLengths[i];
        const coeff = this.coeffs[i];
        const win = this.windows[i];
        const start = total - n;

        // Goertzel recurrence over the windowed tail.
        let s1 = 0;
        let s2 = 0;
        for (let k = 0; k < n; k++) {
          const x = timeData[start + k] * win[k];
          const s0 = x + coeff * s1 - s2;
          s2 = s1;
          s1 = s0;
        }

        const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
        const magnitude = power > 0 ? Math.sqrt(power) : 0;
        // 2 * magnitude / windowSum recovers the sinusoid amplitude for both
        // rectangular and Hann windows, so notes are comparable regardless of N.
        const amp = (2 * magnitude) / this.windowSums[i];
        out[i] = amp > 1 ? 1 : amp;
      }
      return out;
    }
  }

  window.NoteAnalyzer = NoteAnalyzer;
})();
