(() => {
  class CircularWaveBackground {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.bufferA = document.createElement("canvas");
      this.bufferB = document.createElement("canvas");
      this.ctxA = this.bufferA.getContext("2d");
      this.ctxB = this.bufferB.getContext("2d");
      this.latestFrame = null;
      this.active = false;
    }

    init() {
      this.resize();
      this.canvas.style.display = "none";
    }

    onActivate() {
      this.active = true;
      this.canvas.style.display = "block";
    }

    onDeactivate() {
      this.active = false;
      this.canvas.style.display = "none";
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    setAudioFrame(frame) {
      this.latestFrame = frame;
    }

    getClearValue() {
      // Transparent clear so the background canvas remains visible behind WebGPU.
      return { r: 0, g: 0, b: 0, a: 0 };
    }

    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
      const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));

      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
      if (this.bufferA.width !== w || this.bufferA.height !== h) {
        this.bufferA.width = w;
        this.bufferA.height = h;
      }
      if (this.bufferB.width !== w || this.bufferB.height !== h) {
        this.bufferB.width = w;
        this.bufferB.height = h;
      }
    }

    draw() {
      if (!this.active) return;
      this.resize();

      const w = this.canvas.width;
      const h = this.canvas.height;

      // Feedback step: zoom previous frame by 1%, blur by 1px, fade by 3%.
      this.ctxB.clearRect(0, 0, w, h);
      this.ctxB.save();
      this.ctxB.filter = "blur(1px)";
      this.ctxB.globalAlpha = 0.97;
      this.ctxB.translate(w / 2, h / 2);
      this.ctxB.scale(1.01, 1.01);
      this.ctxB.drawImage(this.bufferA, -w / 2, -h / 2, w, h);
      this.ctxB.restore();

      this._drawCircularWaveform(this.ctxB, w, h);

      this.ctx.clearRect(0, 0, w, h);
      this.ctx.drawImage(this.bufferB, 0, 0, w, h);

      const temp = this.bufferA;
      this.bufferA = this.bufferB;
      this.bufferB = temp;
      this.ctxA = this.bufferA.getContext("2d");
      this.ctxB = this.bufferB.getContext("2d");
    }

    _drawCircularWaveform(ctx, w, h) {
      if (!this.latestFrame || !this.latestFrame.waveformData || !this.latestFrame.waveformData[0]) return;
      const waveform = this.latestFrame.waveformData[0];
      if (!waveform.length) return;

      const cx = w * 0.5;
      const cy = h * 0.5;
      const baseRadius = Math.min(w, h) * 0.20;
      const ampRadius = Math.min(w, h) * 0.08;

      ctx.save();
      ctx.lineWidth = Math.max(1, Math.min(w, h) * 0.0024);
      ctx.strokeStyle = "rgba(126, 134, 214, 0.95)";
      ctx.shadowColor = "rgba(177, 123, 232, 0.75)";
      ctx.shadowBlur = 14;
      ctx.beginPath();

      for (let i = 0; i < waveform.length; i++) {
        const t = i / waveform.length;
        const angle = t * Math.PI * 2;
        const radius = baseRadius + waveform[i] * ampRadius;
        const x = cx + Math.cos(angle) * radius;
        const y = cy + Math.sin(angle) * radius;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }
  }

  window.CircularWaveBackground = CircularWaveBackground;
})();
