(() => {
  const GRID_COLS = 32;
  const GRID_ROWS = 18;
  const CELL_COUNT = GRID_COLS * GRID_ROWS;

  const DEFAULT_PRIMARY = { r: 0.961, g: 0.953, b: 1.000, a: 1.0 };
  const DEFAULT_SECONDARY = { r: 0.780, g: 0.639, b: 0.910, a: 1.0 };

  const SHADER_CODE = /* wgsl */`
    struct Uniforms {
      canvasAndGrid: vec4<f32>,
      fillAndPad: vec4<f32>,
      primary: vec4<f32>,
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
      let cellFill = clamp(uni.fillAndPad.x, 0.02, 1.0);
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
      let localX = fract(lx / cellSize) * cellSize;
      let localY = fract(ly / cellSize) * cellSize;
      let inset = cellSize * (1.0 - cellFill) * 0.5;
      if (localX < inset || localX > (cellSize - inset) || localY < inset || localY > (cellSize - inset)) {
        discard;
      }
      let cx = u32(clamp(lx / cellSize, 0.0, gridCols - 1.0));
      let cy = u32(clamp(ly / cellSize, 0.0, gridRows - 1.0));
      let idx = cy * u32(gridCols) + cx;
      let ampLinear = clamp(values[idx], 0.0, 1.0);
      let g = clamp(uni.fillAndPad.y, 0.4, 5.0);
      let amp = pow(ampLinear, g);
      return vec4<f32>(uni.primary.rgb, amp * uni.primary.a);
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

      /** Fraction of each cell’s width/height filled by the lit square (1 = full cell). Default 0.5. */
      this.cellFill = 0.5;
      /** Alpha curve: `pow(linearAmp, gamma)`. Values > 1 need louder audio for the same brightness. */
      this.spectrumGamma = 2;

      this.uniformData = new Float32Array(12);
      this.valuesData = new Float32Array(CELL_COUNT);
    }

    setSettings(partial) {
      if (!partial || typeof partial !== "object") return;
      if (typeof partial.cellFill === "number" && Number.isFinite(partial.cellFill)) {
        this.cellFill = Math.max(0.05, Math.min(1, partial.cellFill));
      }
      if (typeof partial.spectrumGamma === "number" && Number.isFinite(partial.spectrumGamma)) {
        this.spectrumGamma = Math.max(0.4, Math.min(5, partial.spectrumGamma));
      }
    }

    getSettingsSnapshot() {
      return { cellFill: this.cellFill, spectrumGamma: this.spectrumGamma };
    }

    getParameterDescriptors() {
      return {
        title: "Spectrum grid (2D)",
        params: [
          {
            key: "cellFill",
            label: "Square size (fraction of cell)",
            type: "range",
            min: 0.05,
            max: 1,
            step: 0.01
          },
          {
            key: "spectrumGamma",
            label: "Alpha gamma (higher = more volume for same brightness)",
            type: "range",
            min: 0.4,
            max: 5,
            step: 0.05
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
      if (!left?.length || !right?.length) return;

      const nL = left.length;
      const nR = right.length;

      const sampleLinear = (arr, n, t01) => {
        if (n <= 1) return Number(arr[0]) || 0;
        const x = Math.min(1, Math.max(0, t01)) * (n - 1);
        const i0 = Math.floor(x);
        const i1 = Math.min(n - 1, i0 + 1);
        const f = x - i0;
        return arr[i0] * (1 - f) + arr[i1] * f;
      };

      const colsM = GRID_COLS > 1 ? GRID_COLS - 1 : 1;
      const rowsM = GRID_ROWS > 1 ? GRID_ROWS - 1 : 1;

      for (let cy = 0; cy < GRID_ROWS; cy++) {
        const ny = cy / rowsM;
        for (let cx = 0; cx < GRID_COLS; cx++) {
          const nx = cx / colsM;
          // Top-left: low freq left / high freq right; bottom-right: the reverse.
          const tDiag = (nx + ny) * 0.5;
          const vL = sampleLinear(left, nL, tDiag);
          const vR = sampleLinear(right, nR, 1 - tDiag);
          this.valuesData[cy * GRID_COLS + cx] = (vL + vR) * 0.5;
        }
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
      this.uniformData[4] = this.cellFill;
      this.uniformData[5] = this.spectrumGamma;
      this.uniformData[6] = 0;
      this.uniformData[7] = 0;
      const primary = colorToVec4(this.primary);
      this.uniformData[8] = primary[0];
      this.uniformData[9] = primary[1];
      this.uniformData[10] = primary[2];
      this.uniformData[11] = primary[3];

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
