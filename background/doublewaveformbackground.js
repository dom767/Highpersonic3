(() => {
  const MAX_POINTS = 1024;
  const BASE_RADIUS_FRAC = 0.2;
  const AMP_RADIUS_FRAC = 0.07;
  const LINE_WIDTH_PX = 5.0;
  /** Horizontal position of circle centers as fraction of canvas width (0 = left). */
  const LEFT_CENTER_X_FRAC = 0.22;
  const RIGHT_CENTER_X_FRAC = 0.78;

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

  function ndcXFromWidthFrac(frac, w) {
    return (frac * w - w * 0.5) / (w * 0.5);
  }

  /**
   * When minDim equals canvas width (tall/portrait canvases), the circular trace has a large
   * excursion in NDC X and fixed 22%/78% positions push the left ring past x=-1 (clipped).
   * Shrink rings and/or move centers inward until both sides fit with a small margin.
   */
  function computeLayout(w, h, minDim, halfStrokeNdcX) {
    const margin = 0.06;
    let radiusScale = 1;

    for (let attempt = 0; attempt < 12; attempt++) {
      const maxRPx =
        minDim * (BASE_RADIUS_FRAC + AMP_RADIUS_FRAC) * radiusScale
        + (LINE_WIDTH_PX * 0.5 * radiusScale);
      const radiusNdcX = (maxRPx * 2) / w + halfStrokeNdcX;
      const t = margin + radiusNdcX;

      const leftFrac = Math.max(LEFT_CENTER_X_FRAC, t * 0.5);
      const rightFrac = Math.min(RIGHT_CENTER_X_FRAC, 1 - t * 0.5);
      const sepNdc = (2 * rightFrac - 1) - (2 * leftFrac - 1) - 2 * radiusNdcX;

      if (rightFrac > leftFrac && sepNdc > 0.04) {
        const baseR = minDim * BASE_RADIUS_FRAC * radiusScale;
        const ampR = minDim * AMP_RADIUS_FRAC * radiusScale;
        return {
          centerXL: ndcXFromWidthFrac(leftFrac, w),
          centerXR: ndcXFromWidthFrac(rightFrac, w),
          baseR,
          ampR
        };
      }
      radiusScale *= 0.88;
    }

    const baseR = minDim * BASE_RADIUS_FRAC * radiusScale;
    const ampR = minDim * AMP_RADIUS_FRAC * radiusScale;
    const maxRPx =
      minDim * (BASE_RADIUS_FRAC + AMP_RADIUS_FRAC) * radiusScale
      + (LINE_WIDTH_PX * 0.5 * radiusScale);
    const radiusNdcX = (maxRPx * 2) / w + halfStrokeNdcX;
    const leftFrac = Math.max(0.06, Math.min((margin + radiusNdcX) * 0.5, 0.42));
    const rightFrac = Math.min(0.94, Math.max(1 - (margin + radiusNdcX) * 0.5, 0.58));
    return {
      centerXL: ndcXFromWidthFrac(leftFrac, w),
      centerXR: ndcXFromWidthFrac(rightFrac, w),
      baseR,
      ampR
    };
  }

  class DoubleWaveformBackground {
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
    _buildStripVertices(waveform, w, h, baseR, ampR, centerNdcX, centerNdcY) {
      if (!waveform || waveform.length < 3) return null;
      const N = Math.min(waveform.length, MAX_POINTS - 1);
      if (N < 3) return null;
      let vi = 0;
      const halfWidthNdcX = LINE_WIDTH_PX / w;
      const halfWidthNdcY = LINE_WIDTH_PX / h;

      for (let i = 0; i <= N; i++) {
        const si = i % N;
        const angle = (si / N) * Math.PI * 2;
        const r = baseR + waveform[si] * ampR;
        this.centerData[i * 2] = centerNdcX + (Math.cos(angle) * r * 2) / w;
        this.centerData[i * 2 + 1] = centerNdcY + (-Math.sin(angle) * r * 2) / h;
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

      const vertexCount = (N + 1) * 2;
      return { vertexCount, floatCount: vi };
    }

    /** Set `window.hp3DbgDoubleWaveform = true` for throttled console layout logs. */

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
      const halfStrokeNdcX = LINE_WIDTH_PX / w;
      const { centerXL, centerXR, baseR, ampR } = computeLayout(w, h, minDim, halfStrokeNdcX);
      const centerY = 0;

      if (typeof window !== "undefined" && window.hp3DbgDoubleWaveform) {
        this._dbgFrame = (this._dbgFrame ?? 0) + 1;
        if (this._dbgFrame % 90 === 0) {
          console.info("[DoubleWaveform]", {
            w,
            h,
            centerXL: centerXL.toFixed(4),
            centerXR: centerXR.toFixed(4),
            baseR,
            ampR,
            waveformLenL: left.length,
            waveformLenR: (right && right.length) ?? 0
          });
        }
      }

      passEncoder.setPipeline(this.pipeline);
      passEncoder.setBindGroup(0, this.bindGroup);

      const channelR = right && right.length ? right : left;

      const stripL = this._buildStripVertices(left, w, h, baseR, ampR, centerXL, centerY);
      if (stripL) {
        this.device.queue.writeBuffer(this.vertexBufferLeft, 0, this.vertexData.buffer, 0, stripL.floatCount * 4);
        passEncoder.setVertexBuffer(0, this.vertexBufferLeft);
        passEncoder.draw(stripL.vertexCount);
      }

      const stripR = this._buildStripVertices(channelR, w, h, baseR, ampR, centerXR, centerY);
      if (stripR) {
        this.device.queue.writeBuffer(this.vertexBufferRight, 0, this.vertexData.buffer, 0, stripR.floatCount * 4);
        passEncoder.setVertexBuffer(0, this.vertexBufferRight);
        passEncoder.draw(stripR.vertexCount);
      }
    }
  }

  window.DoubleWaveformBackground = DoubleWaveformBackground;
})();
