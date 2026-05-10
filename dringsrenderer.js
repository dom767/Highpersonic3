(() => {
  function cloneDefaultSceneLights() {
    const D = typeof window !== "undefined" && window.SceneLightingDefaults;
    const ld = D && D.lightDir ? D.lightDir : [0.46, 0.64, 0.46];
    return {
      lightDir: [ld[0], ld[1], ld[2]],
      ambient: D ? D.ambient : 0.24,
      diffuse: D ? D.diffuse : 0.76
    };
  }

  const RING_COUNT = 6;
  const U_SEGMENTS = 96;
  const V_SEGMENTS = 56;
  /** Emit wireframe edges only on every Nth subdivison along u / v (torus mesh). */
  const LINE_SEGMENT_STRIDE = 4;
  /** Innermost ring surface alpha; outermost uses RING_ALPHA_OUTERMOST. */
  const RING_ALPHA_INNERMOST = 1.0;
  const RING_ALPHA_OUTERMOST = 0.14;
  /** Multiply equatorial inner radius (R−r); outer (R+r) unchanged; see _writeVertices remapping. */
  const TORUS_INNER_RADIUS_SCALE = 1.3;
  /** Minor radius (tube cross-section); shared by every ring — only R steps per ring. */
  const TORUS_MINOR_RADIUS = 0.10;
  const CELL_COUNT = U_SEGMENTS * V_SEGMENTS;
  const VERTICES_PER_CELL = 4;
  const VERTICES_PER_RING = CELL_COUNT * VERTICES_PER_CELL;
  const FLOATS_PER_VERTEX = 9; // pos.xyz normal.xyz uv.xy ringAlpha
  const STRIDE_BYTES = FLOATS_PER_VERTEX * 4;

  function torusPoint(u, v, major, minor) {
    const cu = Math.cos(u);
    const su = Math.sin(u);
    const cv = Math.cos(v);
    const sv = Math.sin(v);
    const r = major + minor * cv;
    return [r * cu, minor * sv, r * su];
  }

  function torusNormal(u, v) {
    const cu = Math.cos(u);
    const su = Math.sin(u);
    const cv = Math.cos(v);
    const sv = Math.sin(v);
    return [cu * cv, sv, su * cv];
  }

  function normalize3(x, y, z) {
    const len = Math.hypot(x, y, z) || 1;
    return [x / len, y / len, z / len];
  }

  function buildTorusTemplate() {
    const positions = new Float32Array(VERTICES_PER_RING * 3);
    const normals = new Float32Array(VERTICES_PER_RING * 3);
    const major01 = new Float32Array(VERTICES_PER_RING);
    const minor01 = new Float32Array(VERTICES_PER_RING);
    const triIndices = new Uint32Array(CELL_COUNT * 6);
    const lineScratch = [];

    let vtx = 0;
    let tri = 0;
    const major = 1.0;
    const minor = 0.22;

    for (let ui = 0; ui < U_SEGMENTS; ui++) {
      const u0 = (ui / U_SEGMENTS) * Math.PI * 2;
      const u1 = ((ui + 1) / U_SEGMENTS) * Math.PI * 2;
      for (let vi = 0; vi < V_SEGMENTS; vi++) {
        const v0 = (vi / V_SEGMENTS) * Math.PI * 2;
        const v1 = ((vi + 1) / V_SEGMENTS) * Math.PI * 2;

        const p0 = torusPoint(u0, v0, major, minor);
        const p1 = torusPoint(u1, v0, major, minor);
        const p2 = torusPoint(u1, v1, major, minor);
        const p3 = torusPoint(u0, v1, major, minor);
        const nm = torusNormal((u0 + u1) * 0.5, (v0 + v1) * 0.5);

        const base = vtx;
        const verts = [p0, p1, p2, p3];
        const uCorner = [u0, u1, u1, u0];
        const vCorner = [v0, v0, v1, v1];
        const tau = Math.PI * 2;
        for (let i = 0; i < 4; i++) {
          const p = verts[i];
          const po = (vtx + i) * 3;
          positions[po] = p[0];
          positions[po + 1] = p[1];
          positions[po + 2] = p[2];
          normals[po] = nm[0];
          normals[po + 1] = nm[1];
          normals[po + 2] = nm[2];
          major01[vtx + i] = uCorner[i] / tau;
          minor01[vtx + i] = vCorner[i] / tau;
        }

        triIndices[tri++] = base;
        triIndices[tri++] = base + 1;
        triIndices[tri++] = base + 2;
        triIndices[tri++] = base;
        triIndices[tri++] = base + 2;
        triIndices[tri++] = base + 3;

        const S = LINE_SEGMENT_STRIDE;
        if (vi % S === 0) {
          lineScratch.push(base, base + 1);
        }
        if ((vi + 1) % S === 0) {
          lineScratch.push(base + 2, base + 3);
        }
        if (ui % S === 0) {
          lineScratch.push(base + 3, base);
        }
        if ((ui + 1) % S === 0) {
          lineScratch.push(base + 1, base + 2);
        }
        vtx += 4;
      }
    }

    const lineIndices = new Uint32Array(lineScratch);
    return { positions, normals, major01, minor01, triIndices, lineIndices };
  }

  const SHADER_CODE = /* wgsl */`
    struct Uniforms {
      viewProj: mat4x4<f32>,
      lightDir: vec4<f32>,
      ambient: f32,
      diffuse: f32,
    };

    struct VIn {
      @location(0) position: vec3<f32>,
      @location(1) normal: vec3<f32>,
      @location(2) uv: vec2<f32>,
      @location(3) ring_alpha: f32,
    };

    struct VOut {
      @builtin(position) position: vec4<f32>,
      @location(0) normal: vec3<f32>,
      @location(1) uv: vec2<f32>,
      @location(2) ring_alpha: f32,
    };

    @group(0) @binding(0) var<uniform> uni: Uniforms;
    @group(0) @binding(1) var samp: sampler;
    @group(0) @binding(2) var tex: texture_2d<f32>;

    @vertex
    fn vs_main(input: VIn) -> VOut {
      var out: VOut;
      out.position = uni.viewProj * vec4<f32>(input.position, 1.0);
      out.normal = normalize(input.normal);
      out.uv = input.uv;
      out.ring_alpha = input.ring_alpha;
      return out;
    }

    @fragment
    fn fs_fill(
      @location(0) normal: vec3<f32>,
      @location(1) uv: vec2<f32>,
      @location(2) ring_alpha: f32,
    ) -> @location(0) vec4<f32> {
      let l = normalize(uni.lightDir.xyz);
      let n = normalize(normal);
      let diff = max(dot(n, l), 0.0);
      let lit = uni.ambient + diff * uni.diffuse;
      let c = textureSample(tex, samp, uv);
      return vec4<f32>(c.rgb * lit, c.a * ring_alpha);
    }

    @fragment
    fn fs_line(@location(1) uv: vec2<f32>, @location(2) ring_alpha: f32) -> @location(0) vec4<f32> {
      let c = textureSample(tex, samp, uv);
      let edge = c.rgb * 0.16;
      return vec4<f32>(edge, c.a * ring_alpha);
    }
  `;

  class DRingsRenderer {
    constructor(device, format) {
      this.device = device;
      this.format = format;
      this.fillPipeline = null;
      this.linePipeline = null;
      this.uniformBuffer = null;
      this.bindGroup = null;
      this.vertexBuffer = null;
      this.triIndexBuffer = null;
      this.lineIndexBuffer = null;
      this.triIndexCount = 0;
      this.lineIndexCount = 0;
      this.uniformData = new Float32Array(24);
      this.vertexData = new Float32Array(RING_COUNT * VERTICES_PER_RING * FLOATS_PER_VERTEX);
      this.template = buildTorusTemplate();
      this.lastElapsed = null;
      this.bassSustain = 0;
      this.trebleSustain = 0;
      this.sampler = null;
      this.sampledTexture = null;
      this.textureView = null;
      this.bindGroupLayout = null;
      this._boundGpuTextureRef = null;
      this._sceneLights = cloneDefaultSceneLights();
      this.rings = Array.from({ length: RING_COUNT }, () => ({
        angleX: 0,
        angleY: 0,
        velX: 0,
        velY: 0
      }));
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
      if (!this.bindGroupLayout || !this.uniformBuffer) return;
      this._ensureNeutralTextureView();
      this.bindGroup = this.device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: this.textureView }
        ]
      });
    }

    /**
     * @param {GPUTexture | null} gpuTexture full primary texture, or null for neutral white
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
        addressModeU: "repeat",
        addressModeV: "clamp-to-edge"
      });

      const module = this.device.createShaderModule({ code: SHADER_CODE });
      this.bindGroupLayout = this.device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
            buffer: { type: "uniform" }
          },
          {
            binding: 1,
            visibility: GPUShaderStage.FRAGMENT,
            sampler: {}
          },
          {
            binding: 2,
            visibility: GPUShaderStage.FRAGMENT,
            texture: {}
          }
        ]
      });
      const pipelineLayout = this.device.createPipelineLayout({
        bindGroupLayouts: [this.bindGroupLayout]
      });
      const vertex = {
        module,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: STRIDE_BYTES,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x3" },
            { shaderLocation: 2, offset: 24, format: "float32x2" },
            { shaderLocation: 3, offset: 32, format: "float32" }
          ]
        }]
      };

      const alphaBlend = {
        color: {
          srcFactor: "src-alpha",
          dstFactor: "one-minus-src-alpha",
          operation: "add"
        },
        alpha: {
          srcFactor: "one",
          dstFactor: "one-minus-src-alpha",
          operation: "add"
        }
      };

      this.fillPipeline = this.device.createRenderPipeline({
        layout: pipelineLayout,
        vertex,
        fragment: {
          module,
          entryPoint: "fs_fill",
          targets: [{ format: this.format, blend: alphaBlend }]
        },
        primitive: { topology: "triangle-list", frontFace: "cw", cullMode: "back" },
        depthStencil: {
          format: "depth24plus",
          depthWriteEnabled: true,
          depthCompare: "less"
        }
      });

      this.linePipeline = this.device.createRenderPipeline({
        layout: pipelineLayout,
        vertex,
        fragment: {
          module,
          entryPoint: "fs_line",
          targets: [{ format: this.format, blend: alphaBlend }]
        },
        primitive: { topology: "line-list" },
        depthStencil: {
          format: "depth24plus",
          depthWriteEnabled: false,
          depthCompare: "less-equal"
        }
      });

      this.uniformBuffer = this.device.createBuffer({
        size: this.uniformData.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });
      this.vertexBuffer = this.device.createBuffer({
        size: this.vertexData.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
      });

      const ringTriCount = this.template.triIndices.length;
      const ringLineCount = this.template.lineIndices.length;
      this.triIndexCount = ringTriCount * RING_COUNT;
      this.lineIndexCount = ringLineCount * RING_COUNT;
      const allTri = new Uint32Array(this.triIndexCount);
      const allLine = new Uint32Array(this.lineIndexCount);

      for (let r = 0; r < RING_COUNT; r++) {
        const baseVertex = r * VERTICES_PER_RING;
        const triOffset = r * ringTriCount;
        const lineOffset = r * ringLineCount;
        for (let i = 0; i < ringTriCount; i++) allTri[triOffset + i] = this.template.triIndices[i] + baseVertex;
        for (let i = 0; i < ringLineCount; i++) allLine[lineOffset + i] = this.template.lineIndices[i] + baseVertex;
      }

      this.triIndexBuffer = this.device.createBuffer({
        size: allTri.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
      });
      this.lineIndexBuffer = this.device.createBuffer({
        size: allLine.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
      });
      this.device.queue.writeBuffer(this.triIndexBuffer, 0, allTri);
      this.device.queue.writeBuffer(this.lineIndexBuffer, 0, allLine);

      this._rebuildBindGroup();
    }

    setSustain(bassSustain, trebleSustain) {
      this.bassSustain = Math.max(0, Math.min(1, Number(bassSustain) || 0));
      this.trebleSustain = Math.max(0, Math.min(1, Number(trebleSustain) || 0));
    }

    /**
     * @param {{ lightDir: readonly number[], ambient: number, diffuse: number }} state
     */
    setSceneLights(state) {
      if (!state || !state.lightDir || state.lightDir.length < 3) return;
      const L = this._sceneLights;
      L.lightDir[0] = state.lightDir[0];
      L.lightDir[1] = state.lightDir[1];
      L.lightDir[2] = state.lightDir[2];
      L.ambient = state.ambient;
      L.diffuse = state.diffuse;
    }

    pushSpectrum(_sourceSpectrum) {}
    setSettings(_partial) {}

    clearHistory() {
      this.lastElapsed = null;
      for (const ring of this.rings) {
        ring.angleX = 0;
        ring.angleY = 0;
        ring.velX = 0;
        ring.velY = 0;
      }
    }

    _updateDynamics(elapsedSeconds) {
      const dt = this.lastElapsed == null ? 0.016 : Math.max(0.001, Math.min(0.05, elapsedSeconds - this.lastElapsed));
      this.lastElapsed = elapsedSeconds;

      const leadYTarget = 1.8 * this.bassSustain;
      const leadXTarget = 1.4 * this.trebleSustain;
      const leadResponse = 6.0;
      const coupling = 8.5;
      const damping = 2.0;

      const lead = this.rings[0];
      lead.velY += (leadYTarget - lead.velY) * leadResponse * dt;
      lead.velX += (leadXTarget - lead.velX) * leadResponse * dt;
      lead.angleY += lead.velY * dt;
      lead.angleX += lead.velX * dt;

      for (let i = 1; i < RING_COUNT; i++) {
        const prev = this.rings[i - 1];
        const cur = this.rings[i];
        const dy = prev.angleY - cur.angleY;
        const dx = prev.angleX - cur.angleX;
        cur.velY += dy * coupling * dt;
        cur.velX += dx * coupling * dt;
        const drag = Math.exp(-damping * dt);
        cur.velY *= drag;
        cur.velX *= drag;
        cur.angleY += cur.velY * dt;
        cur.angleX += cur.velX * dt;
      }
    }

    _writeVertices() {
      const baseRadius = 0.46;
      const radiusStep = 0.33;
      const unitPos = this.template.positions;
      const unitNrm = this.template.normals;
      const major01 = this.template.major01;
      const minor01 = this.template.minor01;
      const invRingCount = 1 / RING_COUNT;
      let o = 0;

      const ringAlphaDenom = Math.max(1, RING_COUNT - 1);
      const k = TORUS_INNER_RADIUS_SCALE;
      const halfKp1 = 0.5 * (k + 1);
      const halfOneMk = 0.5 * (1 - k);
      for (let ringIndex = 0; ringIndex < RING_COUNT; ringIndex++) {
        const R = baseRadius + ringIndex * radiusStep;
        const r = TORUS_MINOR_RADIUS;
        const radius = halfKp1 * R + halfOneMk * r;
        const ringTube = halfOneMk * R + halfKp1 * r;
        const state = this.rings[ringIndex];
        const ringT = ringIndex / ringAlphaDenom;
        const ringAlpha =
          RING_ALPHA_INNERMOST + ringT * (RING_ALPHA_OUTERMOST - RING_ALPHA_INNERMOST);
        const cx = Math.cos(state.angleX);
        const sx = Math.sin(state.angleX);
        const cy = Math.cos(state.angleY);
        const sy = Math.sin(state.angleY);
        const ringScale = radius;
        const tubeScale = ringTube / 0.22;

        for (let i = 0; i < VERTICES_PER_RING; i++) {
          const po = i * 3;
          const upx = unitPos[po];
          const upy = unitPos[po + 1];
          const upz = unitPos[po + 2];

          const radialLen = Math.hypot(upx, upz) || 1;
          const ringAxisX = upx / radialLen;
          const ringAxisZ = upz / radialLen;
          const centerX = ringAxisX;
          const centerZ = ringAxisZ;
          const localX = (upx - centerX) * tubeScale;
          const localY = upy * tubeScale;
          const localZ = (upz - centerZ) * tubeScale;
          let x = centerX * ringScale + localX;
          let y = localY;
          let z = centerZ * ringScale + localZ;

          const y1 = y * cx - z * sx;
          const z1 = y * sx + z * cx;
          const x2 = x * cy + z1 * sy;
          const z2 = -x * sy + z1 * cy;

          const nx = unitNrm[po];
          const ny = unitNrm[po + 1];
          const nz = unitNrm[po + 2];
          const ny1 = ny * cx - nz * sx;
          const nz1 = ny * sx + nz * cx;
          const nx2 = nx * cy + nz1 * sy;
          const nz2 = -nx * sy + nz1 * cy;
          const nn = normalize3(nx2, ny1, nz2);

          this.vertexData[o++] = x2;
          this.vertexData[o++] = y1;
          this.vertexData[o++] = z2;
          this.vertexData[o++] = nn[0];
          this.vertexData[o++] = nn[1];
          this.vertexData[o++] = nn[2];
          const uTex = major01[i];
          const vBand = (ringIndex + minor01[i]) * invRingCount;
          this.vertexData[o++] = uTex;
          this.vertexData[o++] = vBand;
          this.vertexData[o++] = ringAlpha;
        }
      }

      this.device.queue.writeBuffer(this.vertexBuffer, 0, this.vertexData);
    }

    draw(passEncoder, viewProj, elapsedSeconds) {
      this._updateDynamics(elapsedSeconds);
      this._writeVertices();

      const L = this._sceneLights;
      this.uniformData.set(viewProj, 0);
      this.uniformData[16] = L.lightDir[0];
      this.uniformData[17] = L.lightDir[1];
      this.uniformData[18] = L.lightDir[2];
      this.uniformData[19] = 0;
      this.uniformData[20] = L.ambient;
      this.uniformData[21] = L.diffuse;
      this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);

      passEncoder.setBindGroup(0, this.bindGroup);
      passEncoder.setVertexBuffer(0, this.vertexBuffer);

      passEncoder.setPipeline(this.fillPipeline);
      passEncoder.setIndexBuffer(this.triIndexBuffer, "uint32");
      passEncoder.drawIndexed(this.triIndexCount);

      passEncoder.setPipeline(this.linePipeline);
      passEncoder.setIndexBuffer(this.lineIndexBuffer, "uint32");
      passEncoder.drawIndexed(this.lineIndexCount);
    }
  }

  window.DRingsRenderer = DRingsRenderer;
})();
