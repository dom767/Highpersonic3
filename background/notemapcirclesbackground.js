(() => {
  const PITCH_COUNT = 12;
  const OCTAVE_COUNT = 6;
  const NOTE_COUNT = PITCH_COUNT * OCTAVE_COUNT;

  const DEFAULT_HIGHLIGHT = { r: 0.961, g: 0.953, b: 1.0, a: 1.0 };

  const SHADER_CODE = /* wgsl */`
    struct Uniforms {
      canvasAndGrid: vec4<f32>,
      circleParams: vec4<f32>,
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
      let maxRadiusFrac = clamp(uni.circleParams.x, 0.05, 0.49);
      let edgeSoft = clamp(uni.circleParams.y, 0.001, 0.12);
      let ampGamma = clamp(uni.circleParams.z, 0.4, 5.0);
      let gapFrac = clamp(uni.circleParams.w, 0.0, 0.45);

      let cellW = canvasSize.x / gridCols;
      let cellH = canvasSize.y / gridRows;
      let cellMin = min(cellW, cellH);
      let gap = cellMin * gapFrac;

      if (frag.x < 0.0 || frag.y < 0.0 || frag.x >= canvasSize.x || frag.y >= canvasSize.y) {
        discard;
      }

      let col = u32(clamp(floor(frag.x / cellW), 0.0, gridCols - 1.0));
      let row = u32(clamp(floor(frag.y / cellH), 0.0, gridRows - 1.0));

      let cellCx = (f32(col) + 0.5) * cellW;
      let cellCy = (f32(row) + 0.5) * cellH;
      let dx = frag.x - cellCx;
      let dy = frag.y - cellCy;
      let dist = length(vec2<f32>(dx, dy));

      let maxR = (cellMin - gap) * maxRadiusFrac;
      if (maxR <= 0.0001) {
        discard;
      }

      // Top row = highest octave (C7..B7), matching the audio panel note map.
      let noteRowFromBottom = u32(gridRows) - 1u - row;
      let noteIdx = noteRowFromBottom * u32(gridCols) + col;

      let ampLinear = clamp(values[noteIdx], 0.0, 1.0);
      let amp = pow(ampLinear, ampGamma);
      let radius = amp * maxR;
      if (radius <= 0.0005) {
        discard;
      }

      let edgeInner = radius - edgeSoft * maxR;
      let circleMask = 1.0 - smoothstep(edgeInner, radius, dist);
      let alpha = circleMask * amp * uni.highlight.a;
      if (alpha <= 0.0005) {
        discard;
      }

      return vec4<f32>(uni.highlight.rgb, alpha);
    }
  `;

  function colorToVec4(c) {
    return [c.r, c.g, c.b, c.a ?? 1.0];
  }

  class NoteMapCirclesBackground {
    constructor(options = {}) {
      this.canvas = options.canvas || null;
      this.highlight = { ...DEFAULT_HIGHLIGHT, ...(options.highlight || {}) };

      this.device = null;
      this.format = null;
      this.pipeline = null;
      this.bindGroup = null;
      this.uniformBuffer = null;
      this.valuesBuffer = null;

      /** Max circle radius as a fraction of half the cell (after gap). */
      this.maxRadiusFrac = 0.46;
      /** Softness at circle edge (fraction of max radius). */
      this.edgeSoftness = 0.04;
      /** Alpha curve: `pow(linearAmp, ampGamma)`. */
      this.ampGamma = 1.0;
      /** Gap between cells as a fraction of the smaller cell dimension (matches panel spacing). */
      this.gapFrac = 0.28;

      this.uniformData = new Float32Array(12);
      this.valuesData = new Float32Array(NOTE_COUNT);
    }

    setSettings(partial) {
      if (!partial || typeof partial !== "object") return;
      if (typeof partial.maxRadiusFrac === "number" && Number.isFinite(partial.maxRadiusFrac)) {
        this.maxRadiusFrac = Math.max(0.05, Math.min(0.49, partial.maxRadiusFrac));
      }
      if (typeof partial.edgeSoftness === "number" && Number.isFinite(partial.edgeSoftness)) {
        this.edgeSoftness = Math.max(0.001, Math.min(0.12, partial.edgeSoftness));
      }
      if (typeof partial.ampGamma === "number" && Number.isFinite(partial.ampGamma)) {
        this.ampGamma = Math.max(0.4, Math.min(5, partial.ampGamma));
      }
      if (typeof partial.gapFrac === "number" && Number.isFinite(partial.gapFrac)) {
        this.gapFrac = Math.max(0, Math.min(0.45, partial.gapFrac));
      }
    }

    getSettingsSnapshot() {
      return {
        maxRadiusFrac: this.maxRadiusFrac,
        edgeSoftness: this.edgeSoftness,
        ampGamma: this.ampGamma,
        gapFrac: this.gapFrac
      };
    }

    getParameterDescriptors() {
      return {
        title: "Note map circles",
        params: [
          {
            key: "maxRadiusFrac",
            label: "Max circle size (fraction of cell)",
            type: "range",
            min: 0.05,
            max: 0.49,
            step: 0.01
          },
          {
            key: "gapFrac",
            label: "Cell gap (fraction of cell size)",
            type: "range",
            min: 0,
            max: 0.45,
            step: 0.01
          },
          {
            key: "ampGamma",
            label: "Volume gamma (higher = louder for same size)",
            type: "range",
            min: 0.4,
            max: 5,
            step: 0.05
          },
          {
            key: "edgeSoftness",
            label: "Circle edge softness",
            type: "range",
            min: 0.001,
            max: 0.12,
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

      this.uniformData[0] = w;
      this.uniformData[1] = h;
      this.uniformData[2] = PITCH_COUNT;
      this.uniformData[3] = OCTAVE_COUNT;
      this.uniformData[4] = this.maxRadiusFrac;
      this.uniformData[5] = this.edgeSoftness;
      this.uniformData[6] = this.ampGamma;
      this.uniformData[7] = this.gapFrac;
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

  NoteMapCirclesBackground.PITCH_COUNT = PITCH_COUNT;
  NoteMapCirclesBackground.OCTAVE_COUNT = OCTAVE_COUNT;
  NoteMapCirclesBackground.NOTE_COUNT = NOTE_COUNT;
  NoteMapCirclesBackground.DEFAULT_HIGHLIGHT = DEFAULT_HIGHLIGHT;

  window.NoteMapCirclesBackground = NoteMapCirclesBackground;
})();
