(() => {
  const GRID_SIZE = 64;
  const GRID_DEPTH = 64;
  const TOTAL_VERTS = GRID_SIZE * GRID_DEPTH;
  const QUADS_X = GRID_SIZE - 1;
  const QUADS_Z = GRID_DEPTH - 1;
  const VERTS_PER_CELL = 12;
  const DRAW_VERTEX_COUNT = QUADS_X * QUADS_Z * VERTS_PER_CELL;

  const QS1 = GRID_SIZE - 1;
  const ZS1 = GRID_DEPTH - 1;

  const SHADER_CODE = /* wgsl */ `
    struct Uniforms {
      viewProj: mat4x4<f32>,
      heightScale: f32,
      gridExtentX: f32,
      gridExtentZ: f32,
      time: f32,
    };

    @group(0) @binding(0) var<uniform> uni: Uniforms;
    @group(0) @binding(1) var<storage, read> heights: array<f32>;
    @group(0) @binding(2) var samp: sampler;
    @group(0) @binding(3) var tex: texture_2d<f32>;

    fn h_safe(ix: i32, iz: i32) -> f32 {
      let gx = u32(clamp(ix, i32(0), i32(${GRID_SIZE - 1})));
      let gz = u32(clamp(iz, i32(0), i32(${GRID_DEPTH - 1})));
      return heights[gz * ${GRID_SIZE}u + gx];
    }

    struct VOut {
      @builtin(position) position: vec4<f32>,
      @location(0) uv: vec2<f32>,
    };

    @vertex
    fn vs_main(@builtin(vertex_index) vid: u32) -> VOut {
      let quadIx = vid / ${VERTS_PER_CELL}u;
      let vin = vid % ${VERTS_PER_CELL}u;
      let zi = quadIx / ${QS1}u;
      let xi = quadIx % ${QS1}u;

      let h00 = h_safe(i32(xi), i32(zi));
      let h10 = h_safe(i32(xi) + 1, i32(zi));
      let h01 = h_safe(i32(xi), i32(zi) + 1);
      let h11 = h_safe(i32(xi) + 1, i32(zi) + 1);
      let hC = (h00 + h10 + h01 + h11) * 0.25;

      let invXM1 = 1.0 / f32(${QS1});
      let invZM1 = 1.0 / f32(${ZS1});

      var xNorm: f32;
      var zNorm: f32;
      var h: f32;

      switch (vin) {
        case 0u: { xNorm = (f32(xi) + 0.5) * invXM1; zNorm = (f32(zi) + 0.5) * invZM1; h = hC; }
        case 1u: { xNorm = f32(xi) * invXM1; zNorm = f32(zi) * invZM1; h = h00; }
        case 2u: { xNorm = f32(xi + 1u) * invXM1; zNorm = f32(zi) * invZM1; h = h10; }
        case 3u: { xNorm = (f32(xi) + 0.5) * invXM1; zNorm = (f32(zi) + 0.5) * invZM1; h = hC; }
        case 4u: { xNorm = f32(xi + 1u) * invXM1; zNorm = f32(zi) * invZM1; h = h10; }
        case 5u: { xNorm = f32(xi + 1u) * invXM1; zNorm = f32(zi + 1u) * invZM1; h = h11; }
        case 6u: { xNorm = (f32(xi) + 0.5) * invXM1; zNorm = (f32(zi) + 0.5) * invZM1; h = hC; }
        case 7u: { xNorm = f32(xi + 1u) * invXM1; zNorm = f32(zi + 1u) * invZM1; h = h11; }
        case 8u: { xNorm = f32(xi) * invXM1; zNorm = f32(zi + 1u) * invZM1; h = h01; }
        case 9u: { xNorm = (f32(xi) + 0.5) * invXM1; zNorm = (f32(zi) + 0.5) * invZM1; h = hC; }
        case 10u: { xNorm = f32(xi) * invXM1; zNorm = f32(zi + 1u) * invZM1; h = h01; }
        case 11u: { xNorm = f32(xi) * invXM1; zNorm = f32(zi) * invZM1; h = h00; }
        default: { xNorm = f32(xi) * invXM1; zNorm = f32(zi) * invZM1; h = h00; }
      }

      let x = (xNorm - 0.5) * uni.gridExtentX;
      let z = (zNorm - 0.5) * uni.gridExtentZ;
      let y = h * uni.heightScale;

      var out: VOut;
      out.position = uni.viewProj * vec4<f32>(x, y, z, 1.0);
      out.uv = vec2<f32>(xNorm, zNorm);
      return out;
    }

    @fragment
    fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
      let c = textureSample(tex, samp, uv);
      return vec4<f32>(c.rgb, 1.0);
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
      this.sampler = null;
      this.sampledTexture = null;
      this.textureView = null;
      this.heights = new Float32Array(TOTAL_VERTS);
      this.uniformData = new Float32Array(20);
      this.frontRow = new Float32Array(GRID_SIZE);
      this.settings = { gamma: 0.7, tilt: 1.0, floor: 0.05 };
      this.pipelineLayout = null;
      this.bindGroupLayout = null;
      this._boundGpuTextureRef = null;
    }

    setSettings(partial) {
      if (!partial) return;
      if (typeof partial.gamma === "number") this.settings.gamma = partial.gamma;
      if (typeof partial.tilt === "number") this.settings.tilt = partial.tilt;
      if (typeof partial.floor === "number") this.settings.floor = partial.floor;
    }

    _ensureNeutralTextureView() {
      if (this.sampledTexture) return;
      this.sampledTexture = this.device.createTexture({
        size: [1, 1],
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
      });
      this.device.queue.writeTexture(
        { texture: this.sampledTexture },
        new Uint8Array([255, 255, 255, 255]),
        { bytesPerRow: 4 },
        [1, 1, 1]
      );
      this.textureView = this.sampledTexture.createView();
    }

    _rebuildBindGroup() {
      if (!this.bindGroupLayout || !this.uniformBuffer || !this.heightBuffer) return;
      this._ensureNeutralTextureView();
      this.bindGroup = this.device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: { buffer: this.heightBuffer } },
          { binding: 2, resource: this.sampler },
          { binding: 3, resource: this.textureView }
        ]
      });
    }

    /**
     * @param {GPUTexture | null} gpuTexture full primary texture, or null for neutral
     */
    setSpectrumTexture(gpuTexture) {
      this._ensureNeutralTextureView();
      if (gpuTexture === this._boundGpuTextureRef) return;
      this._boundGpuTextureRef = gpuTexture;
      if (!gpuTexture) {
        this.textureView = this.sampledTexture.createView();
      } else {
        this.textureView = gpuTexture.createView();
      }
      this._rebuildBindGroup();
    }

    init() {
      this.sampler = this.device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge"
      });

      this.heightBuffer = this.device.createBuffer({
        size: TOTAL_VERTS * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      });
      this.device.queue.writeBuffer(this.heightBuffer, 0, this.heights);

      this.uniformBuffer = this.device.createBuffer({
        size: 80,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });

      this.bindGroupLayout = this.device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
            buffer: { type: "uniform" }
          },
          {
            binding: 1,
            visibility: GPUShaderStage.VERTEX,
            buffer: { type: "read-only-storage" }
          },
          {
            binding: 2,
            visibility: GPUShaderStage.FRAGMENT,
            sampler: {}
          },
          {
            binding: 3,
            visibility: GPUShaderStage.FRAGMENT,
            texture: {}
          }
        ]
      });

      this.pipelineLayout = this.device.createPipelineLayout({
        bindGroupLayouts: [this.bindGroupLayout]
      });

      const module = this.device.createShaderModule({ code: SHADER_CODE });
      this.pipeline = this.device.createRenderPipeline({
        layout: this.pipelineLayout,
        vertex: { module, entryPoint: "vs_main" },
        fragment: {
          module,
          entryPoint: "fs_main",
          targets: [{ format: this.format }]
        },
        primitive: {
          topology: "triangle-list",
          cullMode: "none"
        },
        depthStencil: {
          format: "depth24plus",
          depthWriteEnabled: true,
          depthCompare: "less"
        }
      });

      this._boundGpuTextureRef = null;
      this._rebuildBindGroup();
    }

    downsampleToGrid(sourceSpectrum) {
      const out = this.frontRow;
      out.fill(0);
      if (!sourceSpectrum || sourceSpectrum.length === 0) return out;

      const { gamma, tilt, floor } = this.settings;
      const denom = Math.max(1e-6, 1 - floor);

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
        const rms = count > 0 ? Math.sqrt(sumSquares / count) : 0;

        const t = i / (GRID_SIZE - 1);
        let v = (rms - floor) / denom;
        if (v < 0) v = 0;
        v *= 1 + tilt * t;
        v = Math.pow(v, gamma);
        out[i] = v < 0 ? 0 : v > 1 ? 1 : v;
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
      passEncoder.draw(DRAW_VERTEX_COUNT);
    }
  }

  window.GridWireframeRenderer = GridWireframeRenderer;
})();
