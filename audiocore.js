(() => {
  const FRAME_SIZE = 576;

  class AudioCore {
    constructor(options = {}) {
      this.frameSize = options.frameSize || FRAME_SIZE;
      this.fftSize = options.fftSize || 2048;
      this.smoothingTimeConstant = options.smoothingTimeConstant ?? 0;
      this.maxSpectrumHz = options.maxSpectrumHz || 5000;
      this.minDecibels = options.minDecibels ?? -110;
      this.maxDecibels = options.maxDecibels ?? -20;
      this.useFloatSpectrum = true;

      this.audioContext = null;
      this.analyser = null;
      this.mediaStream = null;
      this.sourceNode = null;
      this.lastFrameTime = 0;

      this.byteTimeData = new Uint8Array(this.fftSize);
      this.byteFreqData = new Uint8Array(this.fftSize / 2);
      this.floatFreqData = new Float32Array(this.fftSize / 2);

      this.waveformData = [
        new Float32Array(this.frameSize),
        new Float32Array(this.frameSize)
      ];
      this.spectrumData = [
        new Float32Array(this.frameSize),
        new Float32Array(this.frameSize)
      ];
    }

    static stopTracks(stream) {
      if (!stream) return;
      stream.getTracks().forEach((track) => track.stop());
    }

    async startFromDevice(deviceId) {
      await this.stop();
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      });
      this._connectStream(this.mediaStream);
      return this.mediaStream;
    }

    async startFromDisplay() {
      await this.stop();
      this.mediaStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true
      });
      this._connectStream(this.mediaStream);
      return this.mediaStream;
    }

    _connectStream(stream) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = this.fftSize;
      this.analyser.smoothingTimeConstant = this.smoothingTimeConstant;
      this.analyser.minDecibels = this.minDecibels;
      this.analyser.maxDecibels = this.maxDecibels;

      this.sourceNode = this.audioContext.createMediaStreamSource(stream);
      this.sourceNode.connect(this.analyser);
    }

    getFrame() {
      if (!this.analyser || !this.audioContext) return null;

      this.analyser.getByteTimeDomainData(this.byteTimeData);
      this.analyser.getByteFrequencyData(this.byteFreqData);

      let useFloatSpectrum = this.useFloatSpectrum && typeof this.analyser.getFloatFrequencyData === "function";
      if (useFloatSpectrum) {
        try {
          this.analyser.getFloatFrequencyData(this.floatFreqData);
        } catch (error) {
          // Fall back to byte magnitudes if float extraction fails on a runtime.
          useFloatSpectrum = false;
          this.useFloatSpectrum = false;
        }
      }

      const timeStep = this.byteTimeData.length / this.frameSize;
      const nyquist = this.audioContext.sampleRate * 0.5;
      const cappedMaxHz = Math.max(20, Math.min(this.maxSpectrumHz, nyquist));
      const maxFreqIndex = Math.max(
        1,
        Math.min(
          this.byteFreqData.length - 1,
          Math.floor((cappedMaxHz / nyquist) * (this.byteFreqData.length - 1))
        )
      );
      const freqStep = maxFreqIndex / this.frameSize;
      const dbRange = Math.max(1e-6, this.maxDecibels - this.minDecibels);

      for (let i = 0; i < this.frameSize; i++) {
        const timeIndex = Math.min(this.byteTimeData.length - 1, Math.floor(i * timeStep));
        const freqIndex = Math.min(maxFreqIndex, Math.floor(i * freqStep));

        // Winamp-style layout with modern floats:
        // waveform in [-1, 1], spectrum in [0, 1].
        const waveformSample = (this.byteTimeData[timeIndex] - 128) / 128;
        let spectrumSample;
        if (useFloatSpectrum) {
          const dbSample = this.floatFreqData[freqIndex];
          if (Number.isFinite(dbSample)) {
            const normalizedDb = (dbSample - this.minDecibels) / dbRange;
            spectrumSample = normalizedDb < 0 ? 0 : normalizedDb > 1 ? 1 : normalizedDb;
          } else {
            spectrumSample = 0;
          }
        } else {
          spectrumSample = this.byteFreqData[freqIndex] / 255;
        }

        this.waveformData[0][i] = waveformSample;
        this.waveformData[1][i] = waveformSample;
        this.spectrumData[0][i] = spectrumSample;
        this.spectrumData[1][i] = spectrumSample;
      }

      const now = performance.now();
      const delayMs = this.lastFrameTime > 0 ? now - this.lastFrameTime : 0;
      this.lastFrameTime = now;

      return {
        sRate: this.audioContext.sampleRate,
        nCh: 2,
        latencyMs: 0,
        delayMs,
        spectrumMode: useFloatSpectrum ? "float-db" : "byte",
        cappedMaxHz,
        maxFreqIndex,
        spectrumNch: 2,
        waveformNch: 2,
        spectrumData: this.spectrumData,
        waveformData: this.waveformData
      };
    }

    getCompressedSpectrum(bins = 32, channel = 0) {
      if (!this.analyser) return null;

      const source = this.spectrumData[channel] || this.spectrumData[0];
      const out = new Float32Array(bins);

      for (let i = 0; i < bins; i++) {
        const startIdx = Math.floor((i / bins) * source.length);
        const endIdx = Math.max(startIdx + 1, Math.floor(((i + 1) / bins) * source.length));

        let sumSquares = 0;
        let sampleCount = 0;
        for (let j = startIdx; j < endIdx && j < source.length; j++) {
          const sample = source[j];
          sumSquares += sample * sample;
          sampleCount++;
        }

        out[i] = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0;
      }
      return out;
    }

    async stop() {
      if (this.sourceNode) {
        this.sourceNode.disconnect();
        this.sourceNode = null;
      }
      if (this.mediaStream) {
        AudioCore.stopTracks(this.mediaStream);
        this.mediaStream = null;
      }
      if (this.audioContext) {
        await this.audioContext.close();
        this.audioContext = null;
      }
      this.analyser = null;
      this.lastFrameTime = 0;
    }
  }

  window.AudioCore = AudioCore;
})();
