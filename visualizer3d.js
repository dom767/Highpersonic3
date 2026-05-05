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

  class Visualizer3D {
    static isSupported() {
      return typeof navigator !== "undefined" && !!navigator.gpu;
    }

    constructor() {
      this.canvas = null;
      this.device = null;
      this.context = null;
      this.format = null;
      this.pipeline = null;
      this.bindGroup = null;
      this.uniformBuffer = null;
      this.heightBuffer = null;
      this.indexBuffer = null;
      this.depthTexture = null;

      this.heights = new Float32Array(TOTAL_VERTS);
      this.uniformData = new Float32Array(20);
      this.indexCount = 0;

      this.running = false;
      this.startTime = 0;
      this.camera = new OrbitCamera();
      this._resizeListener = () => this.resize();
    }

    async init(canvas) {
      if (!Visualizer3D.isSupported()) return false;

      this.canvas = canvas;
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return false;

      this.device = await adapter.requestDevice();
      this.context = canvas.getContext("webgpu");
      this.format = navigator.gpu.getPreferredCanvasFormat();
      this.context.configure({
        device: this.device,
        format: this.format,
        alphaMode: "premultiplied"
      });

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

      this.resize();
      window.addEventListener("resize", this._resizeListener);
      return true;
    }

    resize() {
      if (!this.canvas || !this.device) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
      const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
      if (this.depthTexture) {
        this.depthTexture.destroy();
      }
      this.depthTexture = this.device.createTexture({
        size: [this.canvas.width, this.canvas.height],
        format: "depth24plus",
        usage: GPUTextureUsage.RENDER_ATTACHMENT
      });
    }

    pushSpectrum(spectrum32) {
      if (!this.device || !spectrum32) return;
      this.heights.copyWithin(GRID_SIZE, 0, GRID_SIZE * (GRID_DEPTH - 1));
      const limit = Math.min(GRID_SIZE, spectrum32.length);
      for (let i = 0; i < limit; i++) {
        this.heights[i] = spectrum32[i];
      }
      this.device.queue.writeBuffer(this.heightBuffer, 0, this.heights);
    }

    clearHistory() {
      this.heights.fill(0);
      if (this.device) {
        this.device.queue.writeBuffer(this.heightBuffer, 0, this.heights);
      }
    }

    start() {
      if (this.running || !this.device) return;
      this.running = true;
      this.startTime = performance.now();
      this._loop();
    }

    stop() {
      this.running = false;
    }

    _loop() {
      if (!this.running) return;
      this._render();
      requestAnimationFrame(() => this._loop());
    }

    _updateUniforms() {
      const elapsed = (performance.now() - this.startTime) / 1000;
      const aspect = this.canvas.width / Math.max(1, this.canvas.height);
      const viewProj = this.camera.getViewProjection(elapsed, aspect);

      this.uniformData.set(viewProj, 0);
      this.uniformData[16] = 1.8;
      this.uniformData[17] = 4.5;
      this.uniformData[18] = 4.5;
      this.uniformData[19] = elapsed;

      this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);
    }

    _render() {
      this.resize();
      this._updateUniforms();

      const encoder = this.device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0.965, g: 0.96, b: 0.985, a: 1.0 },
          loadOp: "clear",
          storeOp: "store"
        }],
        depthStencilAttachment: {
          view: this.depthTexture.createView(),
          depthClearValue: 1.0,
          depthLoadOp: "clear",
          depthStoreOp: "store"
        }
      });

      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.bindGroup);
      pass.setIndexBuffer(this.indexBuffer, "uint32");
      pass.drawIndexed(this.indexCount);
      pass.end();

      this.device.queue.submit([encoder.finish()]);
    }
  }

  Visualizer3D.GRID_SIZE = GRID_SIZE;
  Visualizer3D.GRID_DEPTH = GRID_DEPTH;
  window.Visualizer3D = Visualizer3D;
})();
