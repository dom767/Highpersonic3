(() => {
  const FRAME_SIZE = 576;
  const FLUX_WINDOW = 60;
  const FLUX_STD_K = 1.5;
  const MIN_BEAT_INTERVAL_MS = 750;

  // --- Kick detection (low-band energy onset) ---
  const KICK_LOWPASS_HZ = 150;        // two cascaded sections isolate the kick band
  const KICK_RMS_SAMPLES = 384;       // short window (~8 ms) for a sharp energy envelope
  const KICK_ENERGY_WINDOW = 43;      // rolling baseline (~0.7 s at 60 fps)
  const KICK_THRESHOLD_K = 1.6;       // beat when energy exceeds mean + K*std of the baseline
  const KICK_ENERGY_FLOOR = 0.004;    // absolute noise gate so silence cannot trigger
  const KICK_REFRACTORY_MS = 160;     // one beat per kick

  class AudioCore {
    constructor(options = {}) {
      this.frameSize = options.frameSize || FRAME_SIZE;
      this.fftSize = options.fftSize || 2048;
      this.smoothingTimeConstant = options.smoothingTimeConstant ?? 0;
      this.maxSpectrumHz = options.maxSpectrumHz || 15000;

      this.audioContext = null;
      this.analyser = null;
      this.analyserL = null;
      this.analyserR = null;
      this.kickMix = null;
      this.kickLowpass = null;
      this.kickLowpass2 = null;
      this.kickAnalyser = null;
      this.channelSplitter = null;
      this.mediaStream = null;
      this.sourceNode = null;
      this.monitorGainNode = null;
      this.lastFrameTime = 0;
      this.bassSustain = 0;
      this.trebleSustain = 0;
      this.bassLevel = 0;
      this.trebleLevel = 0;
      this.lastSustainTimeMs = 0;
      this.treblePrevEnergy = 0;
      this.kickEnergy = 0;
      this.kickThreshold = 0;
      this.kickPrevEnergy = 0;
      /** @type {number[]} */
      this.kickEnergyHistory = [];
      /** @type {number[]} */
      this.trebleFluxHistory = [];
      this.lastKickBeatMs = 0;
      this.lastTrebleBeatMs = 0;

      this.byteTimeData = new Uint8Array(this.fftSize);
      this.byteTimeDataL = new Uint8Array(this.fftSize);
      this.byteTimeDataR = new Uint8Array(this.fftSize);
      this.byteFreqData = new Uint8Array(this.fftSize / 2);
      this.byteFreqDataL = new Uint8Array(this.fftSize / 2);
      this.byteFreqDataR = new Uint8Array(this.fftSize / 2);
      this.kickFloatTime = new Float32Array(this.fftSize);

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
      await this._connectStream(this.mediaStream);
      return this.mediaStream;
    }

    async startFromDisplay() {
      await this.stop();
      this.mediaStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true
      });
      await this._connectStream(this.mediaStream);
      return this.mediaStream;
    }

    async _connectStream(stream) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = this.fftSize;
      this.analyser.smoothingTimeConstant = this.smoothingTimeConstant;

      this.analyserL = this.audioContext.createAnalyser();
      this.analyserR = this.audioContext.createAnalyser();
      this.analyserL.fftSize = this.fftSize;
      this.analyserR.fftSize = this.fftSize;
      this.analyserL.smoothingTimeConstant = this.smoothingTimeConstant;
      this.analyserR.smoothingTimeConstant = this.smoothingTimeConstant;

      this.sourceNode = this.audioContext.createMediaStreamSource(stream);
      this.sourceNode.connect(this.analyser);

      this.channelSplitter = this.audioContext.createChannelSplitter(2);
      this.sourceNode.connect(this.channelSplitter);
      this.channelSplitter.connect(this.analyserL, 0, 0);
      this.channelSplitter.connect(this.analyserR, 1, 0);

      // Dedicated kick path: average L+R to mono, low-pass twice (~24 dB/oct) to
      // isolate the kick band, then read the filtered waveform from an analyser.
      this.kickMix = this.audioContext.createGain();
      this.kickMix.gain.value = 0.5;
      this.channelSplitter.connect(this.kickMix, 0, 0);
      this.channelSplitter.connect(this.kickMix, 1, 0);

      this.kickLowpass = this.audioContext.createBiquadFilter();
      this.kickLowpass.type = "lowpass";
      this.kickLowpass.frequency.value = KICK_LOWPASS_HZ;
      this.kickLowpass.Q.value = 0.707;

      this.kickLowpass2 = this.audioContext.createBiquadFilter();
      this.kickLowpass2.type = "lowpass";
      this.kickLowpass2.frequency.value = KICK_LOWPASS_HZ;
      this.kickLowpass2.Q.value = 0.707;

      this.kickAnalyser = this.audioContext.createAnalyser();
      this.kickAnalyser.fftSize = this.fftSize;
      this.kickAnalyser.smoothingTimeConstant = 0;

      this.kickMix.connect(this.kickLowpass);
      this.kickLowpass.connect(this.kickLowpass2);
      this.kickLowpass2.connect(this.kickAnalyser);

      // Ensure the graph is pulled every render quantum so analyser data updates.
      // Route through a muted gain node to avoid audible playback.
      this.monitorGainNode = this.audioContext.createGain();
      this.monitorGainNode.gain.value = 0;
      this.analyser.connect(this.monitorGainNode);
      this.analyserL.connect(this.monitorGainNode);
      this.analyserR.connect(this.monitorGainNode);
      this.kickAnalyser.connect(this.monitorGainNode);
      this.monitorGainNode.connect(this.audioContext.destination);

      // Some browsers keep contexts suspended until explicitly resumed,
      // which makes analyser output appear flat/empty.
      if (this.audioContext.state === "suspended") {
        try {
          await this.audioContext.resume();
        } catch (error) {
          // Leave context as-is; frame loop fallback/debug will surface issues.
        }
      }
    }

    getFrame() {
      if (!this.analyser || !this.audioContext) return null;

      try {
        this.analyser.getByteTimeDomainData(this.byteTimeData);
        this.analyserL.getByteTimeDomainData(this.byteTimeDataL);
        this.analyserR.getByteTimeDomainData(this.byteTimeDataR);
        this.analyser.getByteFrequencyData(this.byteFreqData);
        this.analyserL.getByteFrequencyData(this.byteFreqDataL);
        this.analyserR.getByteFrequencyData(this.byteFreqDataR);
      } catch (error) {
        throw new Error("analyser-read-failed: " + (error.message || String(error)));
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

      for (let i = 0; i < this.frameSize; i++) {
        const timeIndex = Math.min(this.byteTimeData.length - 1, Math.floor(i * timeStep));
        const freqIndex = Math.min(maxFreqIndex, Math.floor(i * freqStep));

        // Winamp-style layout with modern floats:
        // waveform in [-1, 1], spectrum in [0, 1].
        const waveformSampleL = (this.byteTimeDataL[timeIndex] - 128) / 128;
        const waveformSampleR = (this.byteTimeDataR[timeIndex] - 128) / 128;
        const spectrumSampleL = this.byteFreqDataL[freqIndex] / 255;
        const spectrumSampleR = this.byteFreqDataR[freqIndex] / 255;

        this.waveformData[0][i] = waveformSampleL;
        this.waveformData[1][i] = waveformSampleR;
        this.spectrumData[0][i] = spectrumSampleL;
        this.spectrumData[1][i] = spectrumSampleR;
      }

      const now = performance.now();
      const delayMs = this.lastFrameTime > 0 ? now - this.lastFrameTime : 0;
      this.lastFrameTime = now;

      const specL = this.spectrumData[0];
      const specR = this.spectrumData[1];
      const bassStart = Math.min(specL.length - 1, Math.floor(specL.length * 0.05));
      const bassEnd = Math.max(bassStart + 1, Math.floor(specL.length * 0.10));
      const trebleStart = Math.min(specL.length - 1, Math.floor(specL.length * 0.35));

      let bassSumSquares = 0;
      let bassCount = 0;
      for (let i = bassStart; i < bassEnd; i++) {
        const sample = (specL[i] + specR[i]) * 0.5;
        bassSumSquares += sample * sample;
        bassCount++;
      }
      const bassRms = bassCount > 0 ? Math.sqrt(bassSumSquares / bassCount) : 0;

      let treblePeak = 0;
      for (let i = trebleStart; i < specL.length; i++) {
        const sample = (specL[i] + specR[i]) * 0.5;
        if (sample > treblePeak) treblePeak = sample;
      }

      this.bassLevel = Math.max(0, Math.min(1, bassRms));
      this.trebleLevel = Math.max(0, Math.min(1, treblePeak));

      const trebleSustainBefore = this.trebleSustain;

      const dtSeconds = this.lastSustainTimeMs > 0
        ? (now - this.lastSustainTimeMs) / 1000
        : 0;
      this.lastSustainTimeMs = now;

      const bassDecay = dtSeconds > 0 ? Math.pow(0.5, dtSeconds / 1.5) : 1;
      const trebleDecay = dtSeconds > 0 ? Math.pow(0.5, dtSeconds / 0.4) : 1;
      this.bassSustain = Math.max(this.bassLevel, this.bassSustain * bassDecay);
      this.trebleSustain = Math.max(this.trebleLevel, this.trebleSustain * trebleDecay);

      const stats = (arr) => {
        if (!arr.length) return { mean: 0, std: 0 };
        let sum = 0;
        for (let i = 0; i < arr.length; i++) sum += arr[i];
        const mean = sum / arr.length;
        let variance = 0;
        for (let i = 0; i < arr.length; i++) {
          const d = arr[i] - mean;
          variance += d * d;
        }
        variance /= arr.length;
        return { mean, std: Math.sqrt(variance) };
      };

      // --- Kick detection: onset of low-band energy ---
      // Short-window RMS of the low-passed signal is a sharp energy envelope.
      let kickEnergy = 0;
      if (this.kickAnalyser) {
        this.kickAnalyser.getFloatTimeDomainData(this.kickFloatTime);
        const total = this.kickFloatTime.length;
        const count = Math.min(KICK_RMS_SAMPLES, total);
        let sumSquares = 0;
        for (let i = total - count; i < total; i++) {
          const s = this.kickFloatTime[i];
          sumSquares += s * s;
        }
        kickEnergy = count > 0 ? Math.sqrt(sumSquares / count) : 0;
      }
      this.kickEnergy = kickEnergy;

      // Adaptive threshold from the recent past only (the current frame is pushed
      // afterwards), so a real spike stands out from its own rolling baseline.
      const kickStats = stats(this.kickEnergyHistory);
      const kickThreshold = kickStats.mean + (KICK_THRESHOLD_K * kickStats.std);
      this.kickThreshold = kickThreshold;

      const kickRising = kickEnergy > this.kickPrevEnergy;
      const kickRefractoryOk = (now - this.lastKickBeatMs) >= KICK_REFRACTORY_MS;
      const bassBeat = this.kickEnergyHistory.length >= 12
        && kickEnergy >= KICK_ENERGY_FLOOR
        && kickEnergy > kickThreshold
        && kickRising
        && kickRefractoryOk;

      this.kickPrevEnergy = kickEnergy;
      this.kickEnergyHistory.push(kickEnergy);
      if (this.kickEnergyHistory.length > KICK_ENERGY_WINDOW) this.kickEnergyHistory.shift();

      // --- Treble detection: spectral-flux onset (unchanged) ---
      const trebleFlux = Math.max(0, this.trebleLevel - this.treblePrevEnergy);
      this.treblePrevEnergy = this.trebleLevel;
      this.trebleFluxHistory.push(trebleFlux);
      if (this.trebleFluxHistory.length > FLUX_WINDOW) this.trebleFluxHistory.shift();

      const trebleStats = stats(this.trebleFluxHistory);
      const trebleThreshold = trebleStats.mean + (FLUX_STD_K * trebleStats.std);
      const trebleRefractoryOk = (now - this.lastTrebleBeatMs) >= MIN_BEAT_INTERVAL_MS;
      const trebleAboveSustain = this.trebleLevel > trebleSustainBefore;
      const trebleBeat = this.trebleFluxHistory.length >= 8
        && trebleRefractoryOk
        && trebleAboveSustain
        && trebleFlux > trebleThreshold;

      if (bassBeat) this.lastKickBeatMs = now;
      if (trebleBeat) this.lastTrebleBeatMs = now;

      let bytePeak = 0;
      for (let i = 0; i <= maxFreqIndex; i++) {
        if (this.byteFreqData[i] > bytePeak) bytePeak = this.byteFreqData[i];
      }

      const tracks = this.mediaStream ? this.mediaStream.getAudioTracks() : [];
      const track = tracks.length > 0 ? tracks[0] : null;

      return {
        sRate: this.audioContext.sampleRate,
        nCh: 2,
        latencyMs: 0,
        delayMs,
        contextState: this.audioContext.state,
        bytePeak,
        trackCount: tracks.length,
        trackEnabled: track ? track.enabled : false,
        trackMuted: track ? track.muted : false,
        trackReadyState: track ? track.readyState : "none",
        bassBeat,
        trebleBeat,
        bassLevel: this.bassLevel,
        trebleLevel: this.trebleLevel,
        bassSustain: this.bassSustain,
        trebleSustain: this.trebleSustain,
        kickEnergy: this.kickEnergy,
        kickThreshold: this.kickThreshold,
        kickFloor: KICK_ENERGY_FLOOR,
        spectrumMode: "byte",
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
      if (this.channelSplitter) {
        this.channelSplitter.disconnect();
        this.channelSplitter = null;
      }
      if (this.analyserL) {
        this.analyserL.disconnect();
        this.analyserL = null;
      }
      if (this.analyserR) {
        this.analyserR.disconnect();
        this.analyserR = null;
      }
      if (this.kickMix) {
        this.kickMix.disconnect();
        this.kickMix = null;
      }
      if (this.kickLowpass) {
        this.kickLowpass.disconnect();
        this.kickLowpass = null;
      }
      if (this.kickLowpass2) {
        this.kickLowpass2.disconnect();
        this.kickLowpass2 = null;
      }
      if (this.kickAnalyser) {
        this.kickAnalyser.disconnect();
        this.kickAnalyser = null;
      }
      if (this.monitorGainNode) {
        this.monitorGainNode.disconnect();
        this.monitorGainNode = null;
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
      this.lastSustainTimeMs = 0;
      this.bassLevel = 0;
      this.trebleLevel = 0;
      this.bassSustain = 0;
      this.trebleSustain = 0;
      this.treblePrevEnergy = 0;
      this.kickEnergy = 0;
      this.kickThreshold = 0;
      this.kickPrevEnergy = 0;
      this.kickEnergyHistory = [];
      this.trebleFluxHistory = [];
      this.lastKickBeatMs = 0;
      this.lastTrebleBeatMs = 0;
    }
  }

  window.AudioCore = AudioCore;
})();
