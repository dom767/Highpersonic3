(() => {
  const GRID_SIZE = 64;
  const GRID_DEPTH = 64;
  const TOTAL_VERTS = GRID_SIZE * GRID_DEPTH;

  function mat4Identity() {
    const m = new Float32Array(16);
    m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
    return m;
  }

  function mat4Perspective(fovY, aspect, near, far) {
    const out = new Float32Array(16);
    const f = 1 / Math.tan(fovY * 0.5);
    out[0] = f / aspect;
    out[5] = f;
    out[11] = -1;
    if (Number.isFinite(far)) {
      const nf = 1 / (near - far);
      out[10] = far * nf;
      out[14] = far * near * nf;
    } else {
      out[10] = -1;
      out[14] = -near;
    }
    return out;
  }

  function mat4LookAt(eye, target, up) {
    const out = new Float32Array(16);
    let z0 = eye[0] - target[0];
    let z1 = eye[1] - target[1];
    let z2 = eye[2] - target[2];
    let len = 1 / Math.hypot(z0, z1, z2);
    z0 *= len; z1 *= len; z2 *= len;

    let x0 = up[1] * z2 - up[2] * z1;
    let x1 = up[2] * z0 - up[0] * z2;
    let x2 = up[0] * z1 - up[1] * z0;
    len = Math.hypot(x0, x1, x2);
    if (len > 0) {
      len = 1 / len;
      x0 *= len; x1 *= len; x2 *= len;
    }

    let y0 = z1 * x2 - z2 * x1;
    let y1 = z2 * x0 - z0 * x2;
    let y2 = z0 * x1 - z1 * x0;
    len = Math.hypot(y0, y1, y2);
    if (len > 0) {
      len = 1 / len;
      y0 *= len; y1 *= len; y2 *= len;
    }

    out[0] = x0; out[1] = y0; out[2] = z0; out[3] = 0;
    out[4] = x1; out[5] = y1; out[6] = z1; out[7] = 0;
    out[8] = x2; out[9] = y2; out[10] = z2; out[11] = 0;
    out[12] = -(x0 * eye[0] + x1 * eye[1] + x2 * eye[2]);
    out[13] = -(y0 * eye[0] + y1 * eye[1] + y2 * eye[2]);
    out[14] = -(z0 * eye[0] + z1 * eye[1] + z2 * eye[2]);
    out[15] = 1;
    return out;
  }

  function mat4Multiply(a, b) {
    const out = new Float32Array(16);
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

    for (let col = 0; col < 4; col++) {
      const b0 = b[col * 4 + 0];
      const b1 = b[col * 4 + 1];
      const b2 = b[col * 4 + 2];
      const b3 = b[col * 4 + 3];
      out[col * 4 + 0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
      out[col * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
      out[col * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
      out[col * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    }
    return out;
  }

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
      const angle = elapsed * 0.25;
      const elevation = Math.PI / 4;
      const radius = 5.5;

      const eye = [
        Math.cos(angle) * radius * Math.cos(elevation),
        Math.sin(elevation) * radius,
        Math.sin(angle) * radius * Math.cos(elevation)
      ];
      const target = [0, 0.4, 0];
      const up = [0, 1, 0];

      const aspect = this.canvas.width / Math.max(1, this.canvas.height);
      const proj = mat4Perspective(Math.PI / 4, aspect, 0.1, 100);
      const view = mat4LookAt(eye, target, up);
      const viewProj = mat4Multiply(proj, view);

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
