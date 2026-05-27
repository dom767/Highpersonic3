(() => {
  const MAX_POINTS = 1024;
  const AMP_FRAC = 0.07;
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

  /**
   * Vertical left/right waveform traces — same thick line (triangle-strip) approach as
   * `DoubleWaveformBackground`, but sample index runs bottom→top with horizontal deflection.
   */
  class SideWaveformBackground {
    constructor(options = {}) {
      this.canvas = options.canvas || null;
      this.device = null;
      this.pipeline = null;
      this.bindGroupLayout = null;
      this.bindGroup = null;
      this.uniformBuffer = null;
      this.vertexBufferLeft = null;
      this.vertexBufferRight = null;
      this.centerData = new Float32Array(MAX_POINTS * 2);
      this.vertexData = new Float32Array(MAX_POINTS * 4);
      this.latestFrame = null;
      /** Horizontal spine offset from centre in NDC (−sep left, +sep right); 0…~1. */
      this.separationFromCentre = 0.9;
      /** Half-height of the trace as a fraction of full NDC height (1 = −1…+1). */
      this.waveformHeight = 0.88;
      /** Horizontal excursion multiplier on base amplitude (default 5 = 5× original stroke width). */
      this.amplitudeScale = 5;
    }

    setSettings(partial) {
      if (!partial || typeof partial !== "object") return;
      if (typeof partial.separationFromCentre === "number" && Number.isFinite(partial.separationFromCentre)) {
        this.separationFromCentre = Math.max(0, Math.min(0.98, partial.separationFromCentre));
      }
      if (typeof partial.waveformHeight === "number" && Number.isFinite(partial.waveformHeight)) {
        this.waveformHeight = Math.max(0.12, Math.min(1, partial.waveformHeight));
      }
      if (typeof partial.amplitudeScale === "number" && Number.isFinite(partial.amplitudeScale)) {
        this.amplitudeScale = Math.max(0, Math.min(15, partial.amplitudeScale));
      }
    }

    getSettingsSnapshot() {
      return {
        separationFromCentre: this.separationFromCentre,
        waveformHeight: this.waveformHeight,
        amplitudeScale: this.amplitudeScale
      };
    }

    getParameterDescriptors() {
      return {
        title: "Side waveforms",
        params: [
          {
            key: "separationFromCentre",
            label: "Separation from centre",
            type: "range",
            min: 0,
            max: 0.98,
            step: 0.01
          },
          {
            key: "waveformHeight",
            label: "Height",
            type: "range",
            min: 0.12,
            max: 1,
            step: 0.01
          },
          {
            key: "amplitudeScale",
            label: "Amplitude",
            type: "range",
            min: 0,
            max: 15,
            step: 0.05
          }
        ]
      };
    }

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

      const vbSize = this.vertexData.byteLength;
      this.vertexBufferLeft = device.createBuffer({
        size: vbSize,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
      });
      this.vertexBufferRight = device.createBuffer({
        size: vbSize,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
      });

      this.setLineColor(0.961, 0.953, 1.0, 0.95);
    }

    setAudioFrame(frame) {
      this.latestFrame = frame;
    }

    onActivate() {}
    onDeactivate() {}

    /**
     * @returns {{ vertexCount: number, floatCount: number } | null}
     */
    _buildStripVertices(waveform, w, h, minDim, spineNdcX, verticalHalfSpanNdc) {
      if (!waveform || waveform.length < 3) return null;
      const M = Math.min(waveform.length, MAX_POINTS);
      if (M < 3) return null;
      const ampPx = minDim * AMP_FRAC * this.amplitudeScale;
      let vi = 0;
      const halfWidthNdcX = LINE_WIDTH_PX / w;
      const halfWidthNdcY = LINE_WIDTH_PX / h;

      for (let i = 0; i < M; i++) {
        const t = M <= 1 ? 0 : i / (M - 1);
        const yNdc = -verticalHalfSpanNdc + t * 2 * verticalHalfSpanNdc;
        const xNdc = spineNdcX + waveform[i] * ampPx * (2 / w);
        this.centerData[i * 2] = xNdc;
        this.centerData[i * 2 + 1] = yNdc;
      }

      for (let i = 0; i < M; i++) {
        const prev = i === 0 ? 0 : i - 1;
        const next = i === M - 1 ? M - 1 : i + 1;
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

      const vertexCount = M * 2;
      return { vertexCount, floatCount: vi };
    }

    draw(passEncoder, _viewProj, _elapsed) {
      if (!this.pipeline || !this.latestFrame || !this.canvas) return;
      const wf = this.latestFrame.waveformData;
      if (!wf) return;
      const left = wf[0];
      const right = wf[1];
      if (!left || !left.length) return;

      const w = this.canvas.width || 1;
      const h = this.canvas.height || 1;
      const minDim = Math.min(w, h);
      const sep = this.separationFromCentre;
      const halfSpan = this.waveformHeight;
      const spineL = -sep;
      const spineR = sep;

      passEncoder.setPipeline(this.pipeline);
      passEncoder.setBindGroup(0, this.bindGroup);

      const channelR = right && right.length ? right : left;

      const stripL = this._buildStripVertices(left, w, h, minDim, spineL, halfSpan);
      if (stripL) {
        this.device.queue.writeBuffer(this.vertexBufferLeft, 0, this.vertexData.buffer, this.vertexData.byteOffset, stripL.floatCount * 4);
        passEncoder.setVertexBuffer(0, this.vertexBufferLeft);
        passEncoder.draw(stripL.vertexCount);
      }

      const stripR = this._buildStripVertices(channelR, w, h, minDim, spineR, halfSpan);
      if (stripR) {
        this.device.queue.writeBuffer(this.vertexBufferRight, 0, this.vertexData.buffer, this.vertexData.byteOffset, stripR.floatCount * 4);
        passEncoder.setVertexBuffer(0, this.vertexBufferRight);
        passEncoder.draw(stripR.vertexCount);
      }
    }
  }

  window.SideWaveformBackground = SideWaveformBackground;
})();
