(() => {
  const RING_COUNT = 6;
  const U_SEGMENTS = 96;
  const V_SEGMENTS = 56;
  const CELL_COUNT = U_SEGMENTS * V_SEGMENTS;
  const VERTICES_PER_CELL = 4;
  const VERTICES_PER_RING = CELL_COUNT * VERTICES_PER_CELL;
  const FLOATS_PER_VERTEX = 9; // pos.xyz normal.xyz color.rgb
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
    const triIndices = new Uint32Array(CELL_COUNT * 6);
    const lineIndices = new Uint32Array(CELL_COUNT * 8);

    let vtx = 0;
    let tri = 0;
    let line = 0;
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
        for (let i = 0; i < 4; i++) {
          const p = verts[i];
          const po = (vtx + i) * 3;
          positions[po] = p[0];
          positions[po + 1] = p[1];
          positions[po + 2] = p[2];
          normals[po] = nm[0];
          normals[po + 1] = nm[1];
          normals[po + 2] = nm[2];
        }

        triIndices[tri++] = base;
        triIndices[tri++] = base + 1;
        triIndices[tri++] = base + 2;
        triIndices[tri++] = base;
        triIndices[tri++] = base + 2;
        triIndices[tri++] = base + 3;

        lineIndices[line++] = base;
        lineIndices[line++] = base + 1;
        lineIndices[line++] = base + 1;
        lineIndices[line++] = base + 2;
        lineIndices[line++] = base + 2;
        lineIndices[line++] = base + 3;
        lineIndices[line++] = base + 3;
        lineIndices[line++] = base;
        vtx += 4;
      }
    }

    return { positions, normals, triIndices, lineIndices };
  }

  const SHADER_CODE = /* wgsl */`
    struct Uniforms {
      viewProj: mat4x4<f32>,
      lightDir: vec4<f32>,
    };

    struct VIn {
      @location(0) position: vec3<f32>,
      @location(1) normal: vec3<f32>,
      @location(2) color: vec3<f32>,
    };

    struct VOut {
      @builtin(position) position: vec4<f32>,
      @location(0) normal: vec3<f32>,
      @location(1) color: vec3<f32>,
    };

    @group(0) @binding(0) var<uniform> uni: Uniforms;

    @vertex
    fn vs_main(input: VIn) -> VOut {
      var out: VOut;
      out.position = uni.viewProj * vec4<f32>(input.position, 1.0);
      out.normal = normalize(input.normal);
      out.color = input.color;
      return out;
    }

    @fragment
    fn fs_fill(@location(0) normal: vec3<f32>, @location(1) color: vec3<f32>) -> @location(0) vec4<f32> {
      let l = normalize(uni.lightDir.xyz);
      let n = normalize(normal);
      let diff = max(dot(n, l), 0.0);
      let ambient = 0.24;
      let lit = ambient + diff * 0.76;
      return vec4<f32>(color * lit, 1.0);
    }

    @fragment
    fn fs_line(@location(1) color: vec3<f32>) -> @location(0) vec4<f32> {
      let edge = color * 0.16;
      return vec4<f32>(edge, 1.0);
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
      this.uniformData = new Float32Array(20);
      this.vertexData = new Float32Array(RING_COUNT * VERTICES_PER_RING * FLOATS_PER_VERTEX);
      this.template = buildTorusTemplate();
      this.lastElapsed = null;
      this.bassSustain = 0;
      this.trebleSustain = 0;
      this.rings = Array.from({ length: RING_COUNT }, () => ({
        angleX: 0,
        angleY: 0,
        velX: 0,
        velY: 0
      }));
      this.palette = [
        [0.58, 0.64, 0.96],
        [0.64, 0.62, 0.96],
        [0.70, 0.60, 0.94],
        [0.76, 0.58, 0.92],
        [0.82, 0.56, 0.90],
        [0.88, 0.54, 0.88]
      ];
    }

    init() {
      const module = this.device.createShaderModule({ code: SHADER_CODE });
      const bindGroupLayout = this.device.createBindGroupLayout({
        entries: [{
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" }
        }]
      });
      const pipelineLayout = this.device.createPipelineLayout({
        bindGroupLayouts: [bindGroupLayout]
      });
      const vertex = {
        module,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: STRIDE_BYTES,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x3" },
            { shaderLocation: 2, offset: 24, format: "float32x3" }
          ]
        }]
      };

      this.fillPipeline = this.device.createRenderPipeline({
        layout: pipelineLayout,
        vertex,
        fragment: {
          module,
          entryPoint: "fs_fill",
          targets: [{ format: this.format }]
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
          targets: [{ format: this.format }]
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

      this.bindGroup = this.device.createBindGroup({
        layout: bindGroupLayout,
        entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }]
      });
    }

    setSustain(bassSustain, trebleSustain) {
      this.bassSustain = Math.max(0, Math.min(1, Number(bassSustain) || 0));
      this.trebleSustain = Math.max(0, Math.min(1, Number(trebleSustain) || 0));
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
      let o = 0;

      for (let ringIndex = 0; ringIndex < RING_COUNT; ringIndex++) {
        const radius = baseRadius + ringIndex * radiusStep;
        const ringTube = 0.10 + ringIndex * 0.008;
        const state = this.rings[ringIndex];
        const color = this.palette[ringIndex];
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
          this.vertexData[o++] = color[0];
          this.vertexData[o++] = color[1];
          this.vertexData[o++] = color[2];
        }
      }

      this.device.queue.writeBuffer(this.vertexBuffer, 0, this.vertexData);
    }

    draw(passEncoder, viewProj, elapsedSeconds) {
      this._updateDynamics(elapsedSeconds);
      this._writeVertices();

      this.uniformData.set(viewProj, 0);
      // Top-right of screen, behind the viewer.
      this.uniformData[16] = 0.46;
      this.uniformData[17] = 0.64;
      this.uniformData[18] = 0.46;
      this.uniformData[19] = 0;
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
