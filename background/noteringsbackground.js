(() => {
  const PITCH_COUNT = 12;
  const OCTAVE_COUNT = 6;
  const NOTE_COUNT = PITCH_COUNT * OCTAVE_COUNT;

  const DEFAULT_HIGHLIGHT = { r: 0.961, g: 0.953, b: 1.0, a: 1.0 };

  /** @returns {{ cols: number, rows: number }} */
  function chooseGridLayout(width, height) {
    const aspect = width / Math.max(1, height);
    if (aspect >= 1.7) return { cols: 6, rows: 2 };
    if (aspect >= 0.9) return { cols: 4, rows: 3 };
    if (aspect >= 0.55) return { cols: 3, rows: 4 };
    return { cols: 2, rows: 6 };
  }

  const SHADER_CODE = /* wgsl */`
    struct Uniforms {
      canvasAndGrid: vec4<f32>,
      ringParams: vec4<f32>,
      highlight: vec4<f32>,
    };

    @group(0) @binding(0) var<uniform> uni: Uniforms;
    @group(0) @binding(1) var<storage, read> values: array<f32>;

    @vertex
    fn vs_main(@builtin(vertex_index) vid: u32) -> @builtin(position) vec4<f32> {
      var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 3.0, -1.0),
        vec2<f32>(-1.0,  3.0)
      );
      return vec4<f32>(positions[vid], 0.0, 1.0);
    }

    @fragment
    fn fs_main(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
      let canvasSize = uni.canvasAndGrid.xy;
      let gridCols = uni.canvasAndGrid.z;
      let gridRows = uni.canvasAndGrid.w;
      let octaveCount = max(uni.ringParams.x, 1.0);
      let maxRadiusFrac = clamp(uni.ringParams.y, 0.2, 0.49);
      let edgeSoft = clamp(uni.ringParams.z, 0.001, 0.08);
      let ringThickness = clamp(uni.ringParams.w, 0.08, 1.0);

      let cellSize = min(canvasSize.x / gridCols, canvasSize.y / gridRows);
      let gridW = cellSize * gridCols;
      let gridH = cellSize * gridRows;
      let ox = (canvasSize.x - gridW) * 0.5;
      let oy = (canvasSize.y - gridH) * 0.5;
      let lx = frag.x - ox;
      let ly = frag.y - oy;
      if (lx < 0.0 || ly < 0.0 || lx >= gridW || ly >= gridH) {
        discard;
      }

      let col = u32(clamp(floor(lx / cellSize), 0.0, gridCols - 1.0));
      let row = u32(clamp(floor(ly / cellSize), 0.0, gridRows - 1.0));
      let pitchClass = row * u32(gridCols) + col;

      let cellOx = f32(col) * cellSize + cellSize * 0.5;
      let cellOy = f32(row) * cellSize + cellSize * 0.5;
      let dx = lx - cellOx;
      let dy = ly - cellOy;
      let dist = length(vec2<f32>(dx, dy));
      let maxR = cellSize * maxRadiusFrac;
      if (dist >= maxR) {
        discard;
      }

      let t = dist / maxR;
      let ringF = t * octaveCount;
      let ringIdx = u32(clamp(floor(ringF), 0.0, octaveCount - 1.0));
      let ringLocal = fract(ringF);
      let halfBand = ringThickness * 0.5;
      let bandInner = 0.5 - halfBand;
      let bandOuter = 0.5 + halfBand;
      let bandMask =
        smoothstep(bandInner - edgeSoft, bandInner, ringLocal)
        * (1.0 - smoothstep(bandOuter, bandOuter + edgeSoft, ringLocal));

      let noteIdx = pitchClass + ringIdx * 12u;
      let amp = clamp(values[noteIdx], 0.0, 1.0);
      let alpha = amp * bandMask;
      if (alpha <= 0.0005) {
        discard;
      }

      return vec4<f32>(uni.highlight.rgb, alpha * uni.highlight.a);
    }
  `;

  function colorToVec4(c) {
    return [c.r, c.g, c.b, c.a ?? 1.0];
  }

  class NoteRingsBackground {
    constructor(options = {}) {
      this.canvas = options.canvas || null;
      this.highlight = { ...DEFAULT_HIGHLIGHT, ...(options.highlight || {}) };

      this.device = null;
      this.format = null;
      this.pipeline = null;
      this.bindGroup = null;
      this.uniformBuffer = null;
      this.valuesBuffer = null;

      /** Max ring radius as a fraction of half the cell size (0–0.49). */
      this.maxRadiusFrac = 0.37;
      /** Softness at ring annulus edges (NDC-normalized band width). */
      this.ringEdgeSoftness = 0.034;
      /** Visible radial width of each ring as a fraction of its octave band (0.08–1). */
      this.ringThickness = 0.32;

      this.uniformData = new Float32Array(12);
      this.valuesData = new Float32Array(NOTE_COUNT);
    }

    setSettings(partial) {
      if (!partial || typeof partial !== "object") return;
      if (typeof partial.maxRadiusFrac === "number" && Number.isFinite(partial.maxRadiusFrac)) {
        this.maxRadiusFrac = Math.max(0.2, Math.min(0.49, partial.maxRadiusFrac));
      }
      if (typeof partial.ringEdgeSoftness === "number" && Number.isFinite(partial.ringEdgeSoftness)) {
        this.ringEdgeSoftness = Math.max(0.001, Math.min(0.08, partial.ringEdgeSoftness));
      }
      if (typeof partial.ringThickness === "number" && Number.isFinite(partial.ringThickness)) {
        this.ringThickness = Math.max(0.08, Math.min(1, partial.ringThickness));
      }
    }

    getSettingsSnapshot() {
      return {
        maxRadiusFrac: this.maxRadiusFrac,
        ringEdgeSoftness: this.ringEdgeSoftness,
        ringThickness: this.ringThickness
      };
    }

    getParameterDescriptors() {
      return {
        title: "Note rings",
        params: [
          {
            key: "maxRadiusFrac",
            label: "Ring radius (fraction of cell)",
            type: "range",
            min: 0.2,
            max: 0.49,
            step: 0.01
          },
          {
            key: "ringThickness",
            label: "Ring thickness (fraction of octave band)",
            type: "range",
            min: 0.08,
            max: 1,
            step: 0.01
          },
          {
            key: "ringEdgeSoftness",
            label: "Ring edge softness",
            type: "range",
            min: 0.001,
            max: 0.08,
            step: 0.001
          }
        ]
      };
    }

    init(device, format) {
      this.device = device;
      this.format = format;

      const module = device.createShaderModule({ code: SHADER_CODE });

      const bindGroupLayout = device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
            buffer: { type: "uniform" }
          },
          {
            binding: 1,
            visibility: GPUShaderStage.FRAGMENT,
            buffer: { type: "read-only-storage" }
          }
        ]
      });

      const pipelineLayout = device.createPipelineLayout({
        bindGroupLayouts: [bindGroupLayout]
      });

      this.pipeline = device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module, entryPoint: "vs_main" },
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
        primitive: { topology: "triangle-list" },
        depthStencil: {
          format: "depth24plus",
          depthWriteEnabled: false,
          depthCompare: "always"
        }
      });

      this.uniformBuffer = device.createBuffer({
        size: this.uniformData.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });

      this.valuesBuffer = device.createBuffer({
        size: this.valuesData.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      });

      device.queue.writeBuffer(this.valuesBuffer, 0, this.valuesData);

      this.bindGroup = device.createBindGroup({
        layout: bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: { buffer: this.valuesBuffer } }
        ]
      });
    }

    /**
     * Highlight / accent colour (texture palette primary), linear RGB 0–1.
     */
    setHighlightColor(r, g, b, a = 1.0) {
      this.highlight = { r, g, b, a };
    }

    onActivate() {}

    onDeactivate() {
      this.valuesData.fill(0);
      if (this.device && this.valuesBuffer) {
        this.device.queue.writeBuffer(this.valuesBuffer, 0, this.valuesData);
      }
    }

    setAudioFrame(frame) {
      if (!this.device || !this.valuesBuffer) return;
      if (!frame || !frame.noteData) return;

      const left = frame.noteData[0];
      const right = frame.noteData[1] || frame.noteData[0];
      if (!left?.length) return;

      const len = Math.min(NOTE_COUNT, left.length, right.length);
      for (let i = 0; i < len; i++) {
        this.valuesData[i] = Math.max(0, Math.min(1, ((left[i] || 0) + (right[i] || 0)) * 0.5));
      }
      for (let i = len; i < NOTE_COUNT; i++) {
        this.valuesData[i] = 0;
      }

      this.device.queue.writeBuffer(this.valuesBuffer, 0, this.valuesData);
    }

    draw(passEncoder, _viewProj, _elapsedSeconds) {
      if (!this.pipeline || !this.bindGroup || !this.canvas) return;

      const w = this.canvas.width || 1;
      const h = this.canvas.height || 1;
      const { cols, rows } = chooseGridLayout(w, h);

      this.uniformData[0] = w;
      this.uniformData[1] = h;
      this.uniformData[2] = cols;
      this.uniformData[3] = rows;
      this.uniformData[4] = OCTAVE_COUNT;
      this.uniformData[5] = this.maxRadiusFrac;
      this.uniformData[6] = this.ringEdgeSoftness;
      this.uniformData[7] = this.ringThickness;
      const highlight = colorToVec4(this.highlight);
      this.uniformData[8] = highlight[0];
      this.uniformData[9] = highlight[1];
      this.uniformData[10] = highlight[2];
      this.uniformData[11] = highlight[3];

      this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);

      passEncoder.setPipeline(this.pipeline);
      passEncoder.setBindGroup(0, this.bindGroup);
      passEncoder.draw(3, 1, 0, 0);
    }
  }

  NoteRingsBackground.PITCH_COUNT = PITCH_COUNT;
  NoteRingsBackground.OCTAVE_COUNT = OCTAVE_COUNT;
  NoteRingsBackground.NOTE_COUNT = NOTE_COUNT;
  NoteRingsBackground.DEFAULT_HIGHLIGHT = DEFAULT_HIGHLIGHT;
  NoteRingsBackground.chooseGridLayout = chooseGridLayout;

  window.NoteRingsBackground = NoteRingsBackground;
})();
