(() => {
  const MAX_POINTS = 1024;
  const BASE_RADIUS_FRAC = 0.26;
  const AMP_RADIUS_FRAC = 0.08;
  const LINE_WIDTH_PX = 5.0;

  const SHADER = /* wgsl */`
    struct Uniforms {
      lineColor: vec4<f32>,
    }

    @group(0) @binding(0) var<uniform> uni: Uniforms;

    @vertex
    fn vs_main(@location(0) pos: vec2<f32>) -> @builtin(position) vec4<f32> {
      return vec4<f32>(pos, 0.0, 1.0);
    }

    @fragment
    fn fs_main() -> @location(0) vec4<f32> {
      return uni.lineColor;
    }
  `;

  class CircularWaveBackground {
    constructor(options = {}) {
      this.canvas = options.canvas || null;
      this.device = null;
      this.pipeline = null;
      this.bindGroupLayout = null;
      this.bindGroup = null;
      this.uniformBuffer = null;
      this.vertexBuffer = null;
      this.centerData = new Float32Array(MAX_POINTS * 2);
      this.vertexData = new Float32Array(MAX_POINTS * 4);
      this.vertexCount = 0;
      this.latestFrame = null;
    }

    /**
     * Oscilloscope stroke colour (palette primary / “foreground” accent), linear RGB 0–1.
     */
    setLineColor(r, g, b, a = 0.95) {
      if (!this.device || !this.uniformBuffer) return;
      const u = new Float32Array([r, g, b, a]);
      this.device.queue.writeBuffer(this.uniformBuffer, 0, u);
    }

    init(device, format) {
      this.device = device;

      this.uniformBuffer = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });

      const module = device.createShaderModule({ code: SHADER });

      this.bindGroupLayout = device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.FRAGMENT,
            buffer: { type: "uniform" }
          }
        ]
      });

      this.bindGroup = device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }]
      });

      this.pipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
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
        primitive: { topology: "triangle-strip" },
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

      this.setLineColor(0.961, 0.953, 1.0, 0.95);
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
      if (N < 3) return;
      let vi = 0;
      const halfWidthNdcX = (LINE_WIDTH_PX / w);
      const halfWidthNdcY = (LINE_WIDTH_PX / h);

      for (let i = 0; i <= N; i++) {
        const si = i % N;
        const angle = (si / N) * Math.PI * 2;
        const r = baseR + waveform[si] * ampR;
        this.centerData[i * 2] = Math.cos(angle) * r * 2 / w;
        this.centerData[i * 2 + 1] = -Math.sin(angle) * r * 2 / h;
      }

      for (let i = 0; i <= N; i++) {
        const prev = i === 0 ? N - 1 : i - 1;
        const next = i === N ? 1 : i + 1;
        const px = this.centerData[prev * 2];
        const py = this.centerData[prev * 2 + 1];
        const nx = this.centerData[next * 2];
        const ny = this.centerData[next * 2 + 1];
        let tx = nx - px;
        let ty = ny - py;
        const tLen = Math.hypot(tx, ty) || 1;
        tx /= tLen;
        ty /= tLen;
        const ox = -ty * halfWidthNdcX;
        const oy = tx * halfWidthNdcY;
        const cx = this.centerData[i * 2];
        const cy = this.centerData[i * 2 + 1];

        this.vertexData[vi++] = cx + ox;
        this.vertexData[vi++] = cy + oy;
        this.vertexData[vi++] = cx - ox;
        this.vertexData[vi++] = cy - oy;
      }

      this.vertexCount = (N + 1) * 2;
      this.device.queue.writeBuffer(this.vertexBuffer, 0, this.vertexData, 0, vi);

      passEncoder.setPipeline(this.pipeline);
      passEncoder.setBindGroup(0, this.bindGroup);
      passEncoder.setVertexBuffer(0, this.vertexBuffer);
      passEncoder.draw(this.vertexCount);
    }
  }

  window.CircularWaveBackground = CircularWaveBackground;
})();
