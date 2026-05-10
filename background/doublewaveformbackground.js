(() => {
  const MAX_POINTS = 1024;
  const BASE_RADIUS_FRAC = 0.2;
  const AMP_RADIUS_FRAC = 0.07;
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

  function ndcXFromWidthFrac(frac, w) {
    return (frac * w - w * 0.5) / (w * 0.5);
  }

  /** Nominal horizontal centres from centre-line spacing: 0 = both at middle, 1 = ⅓ & ⅔. */
  function nominalCenterFracs(pairSeparation) {
    const s = Math.max(0, pairSeparation);
    return {
      left: 0.5 + (1 / 3 - 0.5) * s,
      right: 0.5 + (2 / 3 - 0.5) * s
    };
  }

  /** Centres from `pairSeparation`; ring size from `radiusMul` only (no auto shrink / overlap avoidance). */
  function computeLayout(w, h, minDim, pairSeparation, radiusMul) {
    const rm = Math.max(0.05, radiusMul);
    const effBase = BASE_RADIUS_FRAC * rm;
    const effAmp = AMP_RADIUS_FRAC * rm;
    const { left: leftFrac, right: rightFrac } = nominalCenterFracs(pairSeparation);
    const baseR = minDim * effBase;
    const ampR = minDim * effAmp;
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
      /** 0 = both rings at centre; 1 = nominal ⅓ / ⅔ placement; >1 pushes farther toward edges. */
      this.pairSeparation = 1;
      /** Multiplier on base + modulation ring radius (1 = default size). */
      this.radiusScale = 1;
    }

    setSettings(partial) {
      if (!partial || typeof partial !== "object") return;
      if (typeof partial.pairSeparation === "number" && Number.isFinite(partial.pairSeparation)) {
        this.pairSeparation = Math.max(0, Math.min(1.35, partial.pairSeparation));
      }
      if (typeof partial.radiusScale === "number" && Number.isFinite(partial.radiusScale)) {
        this.radiusScale = Math.max(0.35, Math.min(2.2, partial.radiusScale));
      }
    }

    getSettingsSnapshot() {
      return {
        pairSeparation: this.pairSeparation,
        radiusScale: this.radiusScale
      };
    }

    getParameterDescriptors() {
      return {
        title: "Double waveform",
        params: [
          {
            key: "pairSeparation",
            label: "Separation from centre",
            type: "range",
            min: 0,
            max: 1.35,
            step: 0.01
          },
          {
            key: "radiusScale",
            label: "Ring radius",
            type: "range",
            min: 0.35,
            max: 2.2,
            step: 0.01
          }
        ]
      };
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
      const { centerXL, centerXR, baseR, ampR } = computeLayout(
        w,
        h,
        minDim,
        this.pairSeparation,
        this.radiusScale
      );
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
