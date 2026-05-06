(() => {
  const GRID_SIZE = 64;
  const GRID_DEPTH = 64;
  const TOTAL_VERTS = GRID_SIZE * GRID_DEPTH;

  function buildLineIndices() {
    const indices = [];
    for (let z = 0; z < GRID_DEPTH; z++) {
      for (let x = 0; x < GRID_SIZE - 1; x++) {
        const a = z * GRID_SIZE + x;
        indices.push(a, a + 1);
      }
    }
    for (let x = 0; x < GRID_SIZE; x++) {
      for (let z = 0; z < GRID_DEPTH - 1; z++) {
        const a = z * GRID_SIZE + x;
        indices.push(a, a + GRID_SIZE);
      }
    }
    return new Uint32Array(indices);
  }

  const SHADER_CODE = /* wgsl */`
    struct Uniforms {
      viewProj: mat4x4<f32>,
      heightScale: f32,
      gridSize: f32,
      gridDepth: f32,
      time: f32,
    };

    @group(0) @binding(0) var<uniform> uni: Uniforms;
    @group(0) @binding(1) var<storage, read> heights: array<f32>;

    struct VOut {
      @builtin(position) position: vec4<f32>,
      @location(0) height: f32,
      @location(1) gridZ: f32,
    };

    @vertex
    fn vs_main(@builtin(vertex_index) vid: u32) -> VOut {
      let gridX = vid % ${GRID_SIZE}u;
      let gridZ = vid / ${GRID_SIZE}u;
      let h = heights[gridZ * ${GRID_SIZE}u + gridX];

      let xN = f32(gridX) / ${GRID_SIZE - 1}.0;
      let zN = f32(gridZ) / ${GRID_DEPTH - 1}.0;

      let x = (xN - 0.5) * uni.gridSize;
      let z = (zN - 0.5) * uni.gridDepth;
      let y = h * uni.heightScale;

      var out: VOut;
      out.position = uni.viewProj * vec4<f32>(x, y, z, 1.0);
      out.height = h;
      out.gridZ = zN;
      return out;
    }

    @fragment
    fn fs_main(@location(0) height: f32, @location(1) gridZ: f32) -> @location(0) vec4<f32> {
      let lo = vec3<f32>(0.42, 0.55, 0.82);
      let hi = vec3<f32>(0.78, 0.55, 0.82);
      let mixed = mix(lo, hi, gridZ);
      let intensity = mix(0.55, 1.05, clamp(height, 0.0, 1.0));
      return vec4<f32>(mixed * intensity, 1.0);
    }
  `;

  class GridWireframeRenderer {
    static GRID_SIZE = GRID_SIZE;
    static GRID_DEPTH = GRID_DEPTH;

    constructor(device, format) {
      this.device = device;
      this.format = format;
      this.pipeline = null;
      this.bindGroup = null;
      this.uniformBuffer = null;
      this.heightBuffer = null;
      this.indexBuffer = null;
      this.heights = new Float32Array(TOTAL_VERTS);
      this.uniformData = new Float32Array(20);
      this.indexCount = 0;
      this.frontRow = new Float32Array(GRID_SIZE);
    }

    init() {
      const indices = buildLineIndices();
      this.indexCount = indices.length;
      this.indexBuffer = this.device.createBuffer({
        size: indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
      });
      this.device.queue.writeBuffer(this.indexBuffer, 0, indices);

      this.heightBuffer = this.device.createBuffer({
        size: TOTAL_VERTS * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      });
      this.device.queue.writeBuffer(this.heightBuffer, 0, this.heights);

      this.uniformBuffer = this.device.createBuffer({
        size: 80,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });

      const module = this.device.createShaderModule({ code: SHADER_CODE });
      this.pipeline = this.device.createRenderPipeline({
        layout: "auto",
        vertex: { module, entryPoint: "vs_main" },
        fragment: {
          module,
          entryPoint: "fs_main",
          targets: [{ format: this.format }]
        },
        primitive: { topology: "line-list" },
        depthStencil: {
          format: "depth24plus",
          depthWriteEnabled: true,
          depthCompare: "less"
        }
      });

      this.bindGroup = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: { buffer: this.heightBuffer } }
        ]
      });
    }

    downsampleToGrid(sourceSpectrum) {
      const out = this.frontRow;
      out.fill(0);
      if (!sourceSpectrum || sourceSpectrum.length === 0) return out;

      // Represent the full source FFT across the grid width by reducing
      // each source slice into one grid column using RMS.
      for (let i = 0; i < GRID_SIZE; i++) {
        const startIdx = Math.floor((i / GRID_SIZE) * sourceSpectrum.length);
        const endIdx = Math.max(startIdx + 1, Math.floor(((i + 1) / GRID_SIZE) * sourceSpectrum.length));
        let sumSquares = 0;
        let count = 0;
        for (let j = startIdx; j < endIdx && j < sourceSpectrum.length; j++) {
          const sample = sourceSpectrum[j];
          sumSquares += sample * sample;
          count++;
        }
        out[i] = count > 0 ? Math.sqrt(sumSquares / count) : 0;
      }
      return out;
    }

    pushSpectrum(sourceSpectrum) {
      if (!sourceSpectrum) return;
      const spectrum = this.downsampleToGrid(sourceSpectrum);
      this.heights.copyWithin(GRID_SIZE, 0, GRID_SIZE * (GRID_DEPTH - 1));
      for (let i = 0; i < GRID_SIZE; i++) this.heights[i] = spectrum[i];
      this.device.queue.writeBuffer(this.heightBuffer, 0, this.heights);
    }

    clearHistory() {
      this.heights.fill(0);
      this.device.queue.writeBuffer(this.heightBuffer, 0, this.heights);
    }

    draw(passEncoder, viewProj, elapsedSeconds) {
      this.uniformData.set(viewProj, 0);
      this.uniformData[16] = 1.8;
      this.uniformData[17] = 4.5;
      this.uniformData[18] = 4.5;
      this.uniformData[19] = elapsedSeconds;
      this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);

      passEncoder.setPipeline(this.pipeline);
      passEncoder.setBindGroup(0, this.bindGroup);
      passEncoder.setIndexBuffer(this.indexBuffer, "uint32");
      passEncoder.drawIndexed(this.indexCount);
    }
  }

  window.GridWireframeRenderer = GridWireframeRenderer;
})();
