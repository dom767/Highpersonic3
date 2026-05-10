(() => {
  const GRID_COLS = 32;
  const GRID_ROWS = 18;
  const CELL_COUNT = GRID_COLS * GRID_ROWS;

  const DEFAULT_PRIMARY = { r: 0.961, g: 0.953, b: 1.000, a: 1.0 };
  const DEFAULT_SECONDARY = { r: 0.780, g: 0.639, b: 0.910, a: 1.0 };

  const SHADER_CODE = /* wgsl */`
    struct Uniforms {
      canvasSize: vec2<f32>,
      gridCols: f32,
      gridRows: f32,
      primary: vec4<f32>,
      secondary: vec4<f32>,
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
      let cellSize = min(uni.canvasSize.x / uni.gridCols, uni.canvasSize.y / uni.gridRows);
      let gridW = cellSize * uni.gridCols;
      let gridH = cellSize * uni.gridRows;
      let ox = (uni.canvasSize.x - gridW) * 0.5;
      let oy = (uni.canvasSize.y - gridH) * 0.5;
      let lx = frag.x - ox;
      let ly = frag.y - oy;
      if (lx < 0.0 || ly < 0.0 || lx >= gridW || ly >= gridH) {
        return uni.primary;
      }
      let localX = fract(lx / cellSize) * cellSize;
      let localY = fract(ly / cellSize) * cellSize;
      let inset = cellSize * 0.10;
      if (localX < inset || localX > (cellSize - inset) || localY < inset || localY > (cellSize - inset)) {
        return uni.primary;
      }
      let cx = u32(clamp(lx / cellSize, 0.0, uni.gridCols - 1.0));
      let cy = u32(clamp(ly / cellSize, 0.0, uni.gridRows - 1.0));
      let idx = cy * u32(uni.gridCols) + cx;
      let t = clamp(values[idx], 0.0, 1.0);
      let rgb = mix(uni.primary.rgb, uni.secondary.rgb, t);
      return vec4<f32>(rgb, 1.0);
    }
  `;

  function colorToVec4(c) {
    return [c.r, c.g, c.b, c.a ?? 1.0];
  }

  class GridCellsBackground {
    constructor(options = {}) {
      this.canvas = options.canvas || null;
      this.primary = { ...DEFAULT_PRIMARY, ...(options.primary || {}) };
      this.secondary = { ...DEFAULT_SECONDARY, ...(options.secondary || {}) };

      this.device = null;
      this.format = null;
      this.pipeline = null;
      this.bindGroup = null;
      this.uniformBuffer = null;
      this.valuesBuffer = null;

      this.uniformData = new Float32Array(16);
      this.valuesData = new Float32Array(CELL_COUNT);
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
          targets: [{ format }]
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

    setPrimary(color) {
      this.primary = { ...this.primary, ...(color || {}) };
    }

    setSecondary(color) {
      this.secondary = { ...this.secondary, ...(color || {}) };
    }

    getClearValue() {
      return this.primary;
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
      if (!frame || !frame.spectrumData) return;

      const left = frame.spectrumData[0];
      const right = frame.spectrumData[1] || frame.spectrumData[0];
      if (!left) return;

      const limit = Math.min(CELL_COUNT, left.length, right.length);
      for (let i = 0; i < limit; i++) {
        this.valuesData[i] = (left[i] + right[i]) * 0.5;
      }
      for (let i = limit; i < CELL_COUNT; i++) {
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
      this.uniformData[2] = GRID_COLS;
      this.uniformData[3] = GRID_ROWS;
      const primary = colorToVec4(this.primary);
      const secondary = colorToVec4(this.secondary);
      this.uniformData[4] = primary[0];
      this.uniformData[5] = primary[1];
      this.uniformData[6] = primary[2];
      this.uniformData[7] = primary[3];
      this.uniformData[8] = secondary[0];
      this.uniformData[9] = secondary[1];
      this.uniformData[10] = secondary[2];
      this.uniformData[11] = secondary[3];

      this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);

      passEncoder.setPipeline(this.pipeline);
      passEncoder.setBindGroup(0, this.bindGroup);
      passEncoder.draw(3, 1, 0, 0);
    }
  }

  GridCellsBackground.GRID_COLS = GRID_COLS;
  GridCellsBackground.GRID_ROWS = GRID_ROWS;
  GridCellsBackground.CELL_COUNT = CELL_COUNT;
  GridCellsBackground.DEFAULT_PRIMARY = DEFAULT_PRIMARY;
  GridCellsBackground.DEFAULT_SECONDARY = DEFAULT_SECONDARY;

  window.GridCellsBackground = GridCellsBackground;
})();
