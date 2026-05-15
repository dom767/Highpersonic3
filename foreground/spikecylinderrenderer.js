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

  const SEGMENTS = 36;
  const SPIKES_PER_SEGMENT = 16;
  const SPIKE_COUNT = SEGMENTS * SPIKES_PER_SEGMENT;
  const VERTS_PER_SPIKE = 5;
  const TRIS_PER_SPIKE = 4;
  const VERTEX_COUNT = SPIKE_COUNT * VERTS_PER_SPIKE;
  const INDEX_COUNT = SPIKE_COUNT * TRIS_PER_SPIKE * 3;
  const FLOATS_PER_VERTEX = 8;
  const STRIDE_BYTES = FLOATS_PER_VERTEX * 4;
  const CYLINDER_HEIGHT = 2.0;
  /** Minimum radial extent so silent audio still shows a faint cylinder silhouette. */
  const MIN_SPIKE_EXTENT = 0.04;
  const TAU = Math.PI * 2;

  function normalize3(x, y, z) {
    const len = Math.hypot(x, y, z) || 1;
    return [x / len, y / len, z / len];
  }

  function cylPoint(theta, y, r) {
    return [r * Math.cos(theta), y, r * Math.sin(theta)];
  }

  function buildIndexBuffer() {
    const indices = new Uint32Array(INDEX_COUNT);
    let o = 0;
    for (let spike = 0; spike < SPIKE_COUNT; spike++) {
      const base = spike * VERTS_PER_SPIKE;
      const apex = base + 4;
      indices[o++] = apex;
      indices[o++] = base;
      indices[o++] = base + 1;
      indices[o++] = apex;
      indices[o++] = base + 1;
      indices[o++] = base + 2;
      indices[o++] = apex;
      indices[o++] = base + 2;
      indices[o++] = base + 3;
      indices[o++] = apex;
      indices[o++] = base + 3;
      indices[o++] = base;
    }
    return indices;
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
    };

    struct VOut {
      @builtin(position) position: vec4<f32>,
      @location(0) normal: vec3<f32>,
      @location(1) uv: vec2<f32>,
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
      return out;
    }

    @fragment
    fn fs_main(
      @location(0) normal: vec3<f32>,
      @location(1) uv: vec2<f32>
    ) -> @location(0) vec4<f32> {
      let l = normalize(uni.lightDir.xyz);
      let n = normalize(normal);
      let diff = max(dot(n, l), 0.0);
      let lit = uni.ambient + diff * uni.diffuse;
      let c = textureSample(tex, samp, uv);
      return vec4<f32>(c.rgb * lit, c.a);
    }
  `;

  class SpikeCylinderRenderer {
    constructor(device, format) {
      this.device = device;
      this.format = format;
      this.pipeline = null;
      this.uniformBuffer = null;
      this.bindGroup = null;
      this.vertexBuffer = null;
      this.indexBuffer = null;
      this.indexCount = INDEX_COUNT;
      this.uniformData = new Float32Array(24);
      this.vertexData = new Float32Array(VERTEX_COUNT * FLOATS_PER_VERTEX);
      this.positions = new Float32Array(VERTEX_COUNT * 3);
      this.normScratch = new Float32Array(VERTEX_COUNT * 3);
      this.settings = { startRadius: 0.55, spikeScale: 0.85 };
      this.leftSpectrum = new Float32Array(SPIKE_COUNT);
      this.rightSpectrum = new Float32Array(SPIKE_COUNT);
      this.sampler = null;
      this.sampledTexture = null;
      this.textureView = null;
      this.bindGroupLayout = null;
      this._boundGpuTextureRef = null;
      this._sceneLights = cloneDefaultSceneLights();
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
     * @param {GPUTexture | null} gpuTexture
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

    setAudioFrame(frame) {
      if (!frame || !frame.spectrumData) return;
      const left = frame.spectrumData[0];
      const right = frame.spectrumData[1] || left;
      if (!left?.length) return;
      const n = SPIKE_COUNT;
      for (let i = 0; i < n; i++) {
        const li = Math.min(i, left.length - 1);
        const ri = Math.min(n - 1 - i, right.length - 1);
        this.leftSpectrum[i] = left[li];
        this.rightSpectrum[i] = right[ri];
      }
    }

    pushSpectrum(_sourceSpectrum) {}

    setSettings(partial) {
      if (!partial) return;
      if (typeof partial.startRadius === "number") {
        this.settings.startRadius = Math.max(0.2, Math.min(1.5, partial.startRadius));
      }
      if (typeof partial.spikeScale === "number") {
        this.settings.spikeScale = Math.max(0.1, Math.min(3.0, partial.spikeScale));
      }
    }

    getSettingsSnapshot() {
      return {
        startRadius: this.settings.startRadius,
        spikeScale: this.settings.spikeScale
      };
    }

    getParameterDescriptors() {
      return {
        title: "Spike Cylinder",
        params: [
          { key: "startRadius", label: "Start radius", type: "range", min: 0.2, max: 1.5, step: 0.01 },
          { key: "spikeScale", label: "Spike scale", type: "range", min: 0.1, max: 3.0, step: 0.05 }
        ]
      };
    }

    clearHistory() {
      this.leftSpectrum.fill(0);
      this.rightSpectrum.fill(0);
    }

    _sampleSpectrum(arr, index) {
      if (!arr?.length) return 0;
      if (arr.length >= SPIKE_COUNT) return arr[index];
      const t = index / Math.max(1, SPIKE_COUNT - 1);
      const x = t * (arr.length - 1);
      const i0 = Math.floor(x);
      const i1 = Math.min(arr.length - 1, i0 + 1);
      const f = x - i0;
      return arr[i0] * (1 - f) + arr[i1] * f;
    }

    _writeVertices() {
      const { startRadius, spikeScale } = this.settings;
      const halfH = CYLINDER_HEIGHT * 0.5;
      const pos = this.positions;
      const nrm = this.normScratch;
      nrm.fill(0);

      for (let segment = 0; segment < SEGMENTS; segment++) {
        const theta0 = (segment / SEGMENTS) * TAU;
        const theta1 = ((segment + 1) / SEGMENTS) * TAU;

        for (let row = 0; row < SPIKES_PER_SEGMENT; row++) {
          const spike = segment * SPIKES_PER_SEGMENT + row;
          const y0 = (row / SPIKES_PER_SEGMENT) * CYLINDER_HEIGHT - halfH;
          const y1 = ((row + 1) / SPIKES_PER_SEGMENT) * CYLINDER_HEIGHT - halfH;
          const yC = (y0 + y1) * 0.5;
          const thetaC = (theta0 + theta1) * 0.5;
          const vRow = row / SPIKES_PER_SEGMENT;

          const left = this._sampleSpectrum(this.leftSpectrum, spike);
          const right = this._sampleSpectrum(this.rightSpectrum, SPIKE_COUNT - 1 - spike);
          const freq = (left + right) * 0.5;
          const tipR = startRadius + MIN_SPIKE_EXTENT + freq * spikeScale;

          const base = spike * VERTS_PER_SPIKE;
          const corners = [
            cylPoint(theta0, y0, startRadius),
            cylPoint(theta1, y0, startRadius),
            cylPoint(theta1, y1, startRadius),
            cylPoint(theta0, y1, startRadius)
          ];
          const apex = cylPoint(thetaC, yC, tipR);

          for (let c = 0; c < 4; c++) {
            const po = (base + c) * 3;
            pos[po] = corners[c][0];
            pos[po + 1] = corners[c][1];
            pos[po + 2] = corners[c][2];
          }
          const apo = (base + 4) * 3;
          pos[apo] = apex[0];
          pos[apo + 1] = apex[1];
          pos[apo + 2] = apex[2];

          const triVerts = [
            [apex, corners[0], corners[1]],
            [apex, corners[1], corners[2]],
            [apex, corners[2], corners[3]],
            [apex, corners[3], corners[0]]
          ];
          for (const [a, b, c] of triVerts) {
            const ax = b[0] - a[0];
            const ay = b[1] - a[1];
            const az = b[2] - a[2];
            const bx = c[0] - a[0];
            const by = c[1] - a[1];
            const bz = c[2] - a[2];
            let nx = ay * bz - az * by;
            let ny = az * bx - ax * bz;
            let nz = ax * by - ay * bx;
            const nn = normalize3(nx, ny, nz);
            nx = nn[0];
            ny = nn[1];
            nz = nn[2];
            for (const p of [a, b, c]) {
              let vi = -1;
              if (p === apex) vi = base + 4;
              else {
                for (let k = 0; k < 4; k++) {
                  if (p === corners[k]) {
                    vi = base + k;
                    break;
                  }
                }
              }
              if (vi < 0) continue;
              const no = vi * 3;
              nrm[no] += nx;
              nrm[no + 1] += ny;
              nrm[no + 2] += nz;
            }
          }
        }
      }

      const vd = this.vertexData;
      let o = 0;
      for (let vi = 0; vi < VERTEX_COUNT; vi++) {
        const po = vi * 3;
        const nn = normalize3(nrm[po], nrm[po + 1], nrm[po + 2]);
        const spike = Math.floor(vi / VERTS_PER_SPIKE);
        const local = vi % VERTS_PER_SPIKE;
        const segment = Math.floor(spike / SPIKES_PER_SEGMENT);
        const row = spike % SPIKES_PER_SEGMENT;
        let u = segment / SEGMENTS;
        let v = row / SPIKES_PER_SEGMENT;
        if (local === 1) u = (segment + 1) / SEGMENTS;
        else if (local === 2) {
          u = (segment + 1) / SEGMENTS;
          v = (row + 1) / SPIKES_PER_SEGMENT;
        } else if (local === 3) v = (row + 1) / SPIKES_PER_SEGMENT;
        else if (local === 4) {
          u = (segment + 0.5) / SEGMENTS;
          v = (row + 0.5) / SPIKES_PER_SEGMENT;
        }

        vd[o++] = pos[po];
        vd[o++] = pos[po + 1];
        vd[o++] = pos[po + 2];
        vd[o++] = nn[0];
        vd[o++] = nn[1];
        vd[o++] = nn[2];
        vd[o++] = u;
        vd[o++] = v;
      }

      this.device.queue.writeBuffer(this.vertexBuffer, 0, vd);
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
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} }
        ]
      });
      const pipelineLayout = this.device.createPipelineLayout({
        bindGroupLayouts: [this.bindGroupLayout]
      });

      this.pipeline = this.device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: {
          module,
          entryPoint: "vs_main",
          buffers: [{
            arrayStride: STRIDE_BYTES,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 12, format: "float32x3" },
              { shaderLocation: 2, offset: 24, format: "float32x2" }
            ]
          }]
        },
        fragment: {
          module,
          entryPoint: "fs_main",
          targets: [{
            format: this.format,
            blend: {
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
            }
          }]
        },
        primitive: { topology: "triangle-list", frontFace: "cw", cullMode: "back" },
        depthStencil: {
          format: "depth24plus",
          depthWriteEnabled: true,
          depthCompare: "less"
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

      const indices = buildIndexBuffer();
      this.indexBuffer = this.device.createBuffer({
        size: indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
      });
      this.device.queue.writeBuffer(this.indexBuffer, 0, indices);

      this._rebuildBindGroup();
      this._writeVertices();
    }

    draw(passEncoder, viewProj, _elapsedSeconds) {
      if (!this.pipeline || !this.vertexBuffer) return;
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

      passEncoder.setPipeline(this.pipeline);
      passEncoder.setBindGroup(0, this.bindGroup);
      passEncoder.setVertexBuffer(0, this.vertexBuffer);
      passEncoder.setIndexBuffer(this.indexBuffer, "uint32");
      passEncoder.drawIndexed(this.indexCount);
    }
  }

  window.SpikeCylinderRenderer = SpikeCylinderRenderer;
})();
