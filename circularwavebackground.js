(() => {
  const MAX_POINTS = 1024;
  const BASE_RADIUS_FRAC = 0.26;
  const AMP_RADIUS_FRAC = 0.08;

  const SHADER = /* wgsl */`
    @vertex
    fn vs_main(@location(0) pos: vec2<f32>) -> @builtin(position) vec4<f32> {
      return vec4<f32>(pos, 0.0, 1.0);
    }

    @fragment
    fn fs_main() -> @location(0) vec4<f32> {
      return vec4<f32>(0.494, 0.525, 0.839, 0.95);
    }
  `;

  class CircularWaveBackground {
    constructor(options = {}) {
      this.canvas = options.canvas || null;
      this.device = null;
      this.pipeline = null;
      this.vertexBuffer = null;
      this.vertexData = new Float32Array(MAX_POINTS * 2);
      this.vertexCount = 0;
      this.latestFrame = null;
    }

    init(device, format) {
      this.device = device;

      const module = device.createShaderModule({ code: SHADER });

      this.pipeline = device.createRenderPipeline({
        layout: "auto",
        vertex: {
          module,
          entryPoint: "vs_main",
          buffers: [{
            arrayStride: 8,
            attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }]
          }]
        },
        fragment: {
          module,
          entryPoint: "fs_main",
          targets: [{
            format,
            blend: {
              color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }
            }
          }]
        },
        primitive: { topology: "line-strip" },
        depthStencil: {
          format: "depth24plus",
          depthWriteEnabled: false,
          depthCompare: "always"
        }
      });

      this.vertexBuffer = device.createBuffer({
        size: this.vertexData.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
      });
    }

    setAudioFrame(frame) {
      this.latestFrame = frame;
    }

    onActivate() {}
    onDeactivate() {}

    draw(passEncoder, _viewProj, _elapsed) {
      if (!this.pipeline || !this.latestFrame || !this.canvas) return;
      const waveform = this.latestFrame.waveformData && this.latestFrame.waveformData[0];
      if (!waveform || !waveform.length) return;

      const w = this.canvas.width || 1;
      const h = this.canvas.height || 1;
      const minDim = Math.min(w, h);
      const baseR = minDim * BASE_RADIUS_FRAC;
      const ampR = minDim * AMP_RADIUS_FRAC;
      const N = Math.min(waveform.length, MAX_POINTS - 1);
      let vi = 0;

      for (let i = 0; i <= N; i++) {
        const si = i % N;
        const angle = (si / N) * Math.PI * 2;
        const r = baseR + waveform[si] * ampR;
        this.vertexData[vi++] = Math.cos(angle) * r * 2 / w;
        this.vertexData[vi++] = -Math.sin(angle) * r * 2 / h;
      }

      this.vertexCount = N + 1;
      this.device.queue.writeBuffer(this.vertexBuffer, 0, this.vertexData, 0, vi);

      passEncoder.setPipeline(this.pipeline);
      passEncoder.setVertexBuffer(0, this.vertexBuffer);
      passEncoder.draw(this.vertexCount);
    }
  }

  window.CircularWaveBackground = CircularWaveBackground;
})();
