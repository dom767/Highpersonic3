(() => {
  const FADE = 0.995;
  const BLUR_PX = 0.65;
  const CELL_COUNT = 12;
  const RADIAL_SPEED = 80;
  const EDGE_SPEED = 55;
  const EDGE_BAND_OUTER = 0.22;
  const SPEED_SCALE = 1.0;

  const COMPOSE_SHADER = /* wgsl */`
    struct Uniforms {
      canvasAndTime: vec4<f32>,
      rates: vec4<f32>,
      pattern: vec4<f32>,
      blurPad: vec4<f32>,
      fadeColor: vec4<f32>,
    }

    @group(0) @binding(0) var<uniform> uni: Uniforms;
    @group(0) @binding(1) var samp: sampler;
    @group(0) @binding(2) var prevTex: texture_2d<f32>;

    struct VSOut {
      @builtin(position) position: vec4<f32>,
      @location(0) uv: vec2<f32>,
    }

    struct BrickCell {
      local: vec2<f32>,
      parity: u32,
    }

    @vertex
    fn vs_main(@builtin(vertex_index) vid: u32) -> VSOut {
      var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0)
      );
      var out: VSOut;
      let p = positions[vid];
      out.position = vec4<f32>(p, 0.0, 1.0);
      out.uv = vec2<f32>((p.x + 1.0) * 0.5, 1.0 - (p.y + 1.0) * 0.5);
      return out;
    }

    fn brick_cell(pPx: vec2<f32>, cellSize: f32) -> BrickCell {
      let row = floor(pPx.y / cellSize);
      let xShift = select(0.0, cellSize * 0.5, (u32(row) & 1u) == 1u);
      let shiftedX = pPx.x + xShift;
      let col = floor(shiftedX / cellSize);
      let local = vec2<f32>(fract(shiftedX / cellSize), fract(pPx.y / cellSize));
      let parity = (u32(col) + u32(row)) & 1u;
      return BrickCell(local, parity);
    }

    fn edge_tangent(local: vec2<f32>, clockwise: bool) -> vec2<f32> {
      let dirSign = select(-1.0, 1.0, clockwise);
      let eps = 0.0005;
      let dTop = local.y;
      let dBottom = 1.0 - local.y;
      let dLeft = local.x;
      let dRight = 1.0 - local.x;

      let wTop = 1.0 / (dTop + eps);
      let wBottom = 1.0 / (dBottom + eps);
      let wLeft = 1.0 / (dLeft + eps);
      let wRight = 1.0 / (dRight + eps);

      var t = wTop * vec2<f32>(1.0, 0.0)
        + wRight * vec2<f32>(0.0, 1.0)
        + wBottom * vec2<f32>(-1.0, 0.0)
        + wLeft * vec2<f32>(0.0, -1.0);
      let len = length(t);
      if (len < eps) {
        return vec2<f32>(0.0, 0.0);
      }
      return (t / len) * dirSign;
    }

    fn advect_uv(uv: vec2<f32>, canvasPx: vec2<f32>, dt: f32) -> vec2<f32> {
      let cellSize = uni.pattern.x;
      let edgeBandOuter = uni.pattern.y;
      let edgeBandInner = uni.pattern.z;
      let radialSpeed = uni.rates.y;
      let edgeSpeed = uni.rates.z;
      let speedScale = uni.rates.w;

      let pPx = uv * canvasPx;
      let cell = brick_cell(pPx, cellSize);
      let local = cell.local;
      let clockwise = cell.parity == 0u;

      let toCenter = vec2<f32>(0.5) - local;
      let centerDist = length(toCenter);
      var radialDir = vec2<f32>(0.0, 0.0);
      if (centerDist > 0.0001) {
        radialDir = -toCenter / centerDist;
      }

      let tangentDir = edge_tangent(local, clockwise);

      let edgeDist = min(min(local.x, 1.0 - local.x), min(local.y, 1.0 - local.y));
      let wEdge = 1.0 - smoothstep(edgeBandInner, edgeBandOuter, edgeDist);
      let wRad = 1.0 - wEdge;

      let velPx = (wRad * radialDir * radialSpeed + wEdge * tangentDir * edgeSpeed) * speedScale;
      let samplePx = pPx - velPx * dt;
      return samplePx / canvasPx;
    }

    fn sample_advected_prev(uv: vec2<f32>, canvasPx: vec2<f32>, dt: f32) -> vec4<f32> {
      let uvs = advect_uv(uv, canvasPx, dt);
      return textureSampleLevel(prevTex, samp, uvs, 0.0);
    }

    fn blur_advected(uv: vec2<f32>, canvasPx: vec2<f32>, blurPx: f32, dt: f32) -> vec4<f32> {
      let px = blurPx / canvasPx;
      let w0 = 0.227027;
      let w1 = 0.316216;
      let w2 = 0.070270;
      let total = w0 + 4.0 * w1 + 4.0 * w2;
      var acc = sample_advected_prev(uv, canvasPx, dt) * w0;
      acc += sample_advected_prev(uv + vec2<f32>(px.x, 0.0), canvasPx, dt) * w1;
      acc += sample_advected_prev(uv - vec2<f32>(px.x, 0.0), canvasPx, dt) * w1;
      acc += sample_advected_prev(uv + vec2<f32>(2.0 * px.x, 0.0), canvasPx, dt) * w2;
      acc += sample_advected_prev(uv - vec2<f32>(2.0 * px.x, 0.0), canvasPx, dt) * w2;
      acc += sample_advected_prev(uv + vec2<f32>(0.0, px.y), canvasPx, dt) * w1;
      acc += sample_advected_prev(uv - vec2<f32>(0.0, px.y), canvasPx, dt) * w1;
      acc += sample_advected_prev(uv + vec2<f32>(0.0, 2.0 * px.y), canvasPx, dt) * w2;
      acc += sample_advected_prev(uv - vec2<f32>(0.0, 2.0 * px.y), canvasPx, dt) * w2;
      return acc / total;
    }

    fn quantizedFadeStep(current: f32, targetValue: f32, fade: f32) -> f32 {
      let mixed = mix(targetValue, current, fade);
      let curByte = i32(round(clamp(current, 0.0, 1.0) * 255.0));
      let tgtByte = i32(round(clamp(targetValue, 0.0, 1.0) * 255.0));
      var outByte = i32(round(clamp(mixed, 0.0, 1.0) * 255.0));
      if (curByte != tgtByte && outByte == curByte) {
        if (tgtByte > curByte) {
          outByte = curByte + 1;
        } else {
          outByte = curByte - 1;
        }
      }
      outByte = clamp(outByte, 0, 255);
      return f32(outByte) / 255.0;
    }

    @fragment
    fn fs_compose(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
      let canvasPx = uni.canvasAndTime.xy;
      let dt = uni.canvasAndTime.w;
      let fade = uni.rates.x;
      let blurPx = uni.blurPad.x;

      let blurred = blur_advected(uv, canvasPx, blurPx, dt);
      let rgb = vec3<f32>(
        quantizedFadeStep(blurred.r, uni.fadeColor.r, fade),
        quantizedFadeStep(blurred.g, uni.fadeColor.g, fade),
        quantizedFadeStep(blurred.b, uni.fadeColor.b, fade)
      );
      return vec4<f32>(rgb, 1.0);
    }
  `;

  const PRESENT_SHADER = /* wgsl */`
    struct VSOut {
      @builtin(position) position: vec4<f32>,
      @location(0) uv: vec2<f32>,
    }

    @group(0) @binding(0) var samp: sampler;
    @group(0) @binding(1) var fbTex: texture_2d<f32>;

    @vertex
    fn vs_present(@builtin(vertex_index) vid: u32) -> VSOut {
      var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0)
      );
      var out: VSOut;
      let p = positions[vid];
      out.position = vec4<f32>(p, 0.0, 1.0);
      out.uv = vec2<f32>((p.x + 1.0) * 0.5, 1.0 - (p.y + 1.0) * 0.5);
      return out;
    }

    @fragment
    fn fs_present(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
      let c = textureSample(fbTex, samp, uv);
      return vec4<f32>(c.rgb, 1.0);
    }
  `;

  class StainedGlassCellEffect {
    constructor() {
      this.device = null;
      this.format = null;
      this.canvas = null;
      this.sampler = null;
      this.uniformBuffer = null;
      /** 20 floats: 5 vec4 */
      this.uniformData = new Float32Array(20);
      this.fadeColor = { r: 0.965, g: 0.96, b: 0.985 };
      this.fadeColorFollowsBackground = true;
      this.sceneBackgroundColor = null;
      this.composeBGLayout = null;
      this.composePipeline = null;
      this.presentBGLayout = null;
      this.presentPipeline = null;
      this.feedbackA = null;
      this.feedbackB = null;
      this.feedbackWidth = 0;
      this.feedbackHeight = 0;
      this.readIndex = 0;
      this.composeBindGroup = null;
      this.presentBindGroup = null;
      this._lastElapsedSec = null;

      this.cellCount = CELL_COUNT;
      this.radialSpeed = RADIAL_SPEED;
      this.edgeSpeed = EDGE_SPEED;
      this.edgeBandOuter = EDGE_BAND_OUTER;
      this.speedScale = SPEED_SCALE;
    }

    init(device, format, canvas) {
      this.device = device;
      this.format = format;
      this.canvas = canvas;

      this.sampler = device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge"
      });

      this.uniformBuffer = device.createBuffer({
        size: 80,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });

      const composeModule = device.createShaderModule({ code: COMPOSE_SHADER });
      const presentModule = device.createShaderModule({ code: PRESENT_SHADER });

      this.composeBGLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } }
        ]
      });

      this.presentBGLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } }
        ]
      });

      this.composePipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.composeBGLayout] }),
        vertex: { module: composeModule, entryPoint: "vs_main" },
        fragment: {
          module: composeModule,
          entryPoint: "fs_compose",
          targets: [{ format }]
        },
        primitive: { topology: "triangle-list" }
      });

      this.presentPipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.presentBGLayout] }),
        vertex: { module: presentModule, entryPoint: "vs_present" },
        fragment: {
          module: presentModule,
          entryPoint: "fs_present",
          targets: [{ format }]
        },
        primitive: { topology: "triangle-list" }
      });

      this._resizeTexturesIfNeeded(true);
      this._rebuildBindGroups();
    }

    setFadeColor(r, g, b) {
      this.fadeColor = { r, g, b };
    }

    setSceneBackgroundColor(r, g, b) {
      this.sceneBackgroundColor = { r, g, b };
      if (this.device) this._resizeTexturesIfNeeded(true);
    }

    _feedbackRead() {
      return this.readIndex === 0 ? this.feedbackA : this.feedbackB;
    }

    _feedbackWrite() {
      return this.readIndex === 0 ? this.feedbackB : this.feedbackA;
    }

    _rebuildBindGroups() {
      if (!this.device || !this.feedbackA) return;

      this.composeBindGroup = this.device.createBindGroup({
        layout: this.composeBGLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: this._feedbackRead().createView() }
        ]
      });

      this.presentBindGroup = this.device.createBindGroup({
        layout: this.presentBGLayout,
        entries: [
          { binding: 0, resource: this.sampler },
          { binding: 1, resource: this._feedbackWrite().createView() }
        ]
      });
    }

    _resizeTexturesIfNeeded(force) {
      if (!this.device || !this.canvas) return;
      const w = this.canvas.width || 1;
      const h = this.canvas.height || 1;

      const needRebuild = force || !this.feedbackA
        || this.feedbackWidth !== w || this.feedbackHeight !== h;

      if (!needRebuild) return;

      for (const t of [this.feedbackA, this.feedbackB]) {
        if (t) t.destroy();
      }

      const texDesc = {
        size: [w, h],
        format: this.format,
        usage: GPUTextureUsage.TEXTURE_BINDING
          | GPUTextureUsage.RENDER_ATTACHMENT
      };

      this.feedbackA = this.device.createTexture(texDesc);
      this.feedbackB = this.device.createTexture(texDesc);
      this.feedbackWidth = w;
      this.feedbackHeight = h;

      const fc = this.sceneBackgroundColor ?? this.fadeColor;
      const clearEncoder = this.device.createCommandEncoder();
      for (const tex of [this.feedbackA, this.feedbackB]) {
        const pass = clearEncoder.beginRenderPass({
          colorAttachments: [{
            view: tex.createView(),
            clearValue: { r: fc.r, g: fc.g, b: fc.b, a: 1.0 },
            loadOp: "clear",
            storeOp: "store"
          }]
        });
        pass.end();
      }
      this.device.queue.submit([clearEncoder.finish()]);
      this._rebuildBindGroups();
    }

    resize() {
      this._resizeTexturesIfNeeded(false);
    }

    reset() {
      if (!this.feedbackA) return;
      this.readIndex = 0;
      this._lastElapsedSec = null;
      this._resizeTexturesIfNeeded(true);
    }

    getFeedbackWriteView() {
      return this._feedbackWrite() ? this._feedbackWrite().createView() : null;
    }

    flipFeedback() {
      this.readIndex = 1 - this.readIndex;
      this._rebuildBindGroups();
    }

    _writeUniforms(elapsedSec) {
      const w = this.canvas.width || 1;
      const h = this.canvas.height || 1;
      let dt = 1 / 60;
      if (this._lastElapsedSec !== null && typeof elapsedSec === "number") {
        dt = Math.max(1 / 500, Math.min(1 / 30, elapsedSec - this._lastElapsedSec));
      }
      if (typeof elapsedSec === "number") {
        this._lastElapsedSec = elapsedSec;
      }

      const cellSize = Math.min(w, h) / Math.max(1, this.cellCount);
      const edgeBandInner = this.edgeBandOuter * 0.35;

      const u = this.uniformData;
      u[0] = w;
      u[1] = h;
      u[2] = typeof elapsedSec === "number" ? elapsedSec : 0;
      u[3] = dt;

      u[4] = FADE;
      u[5] = this.radialSpeed;
      u[6] = this.edgeSpeed;
      u[7] = this.speedScale;

      u[8] = cellSize;
      u[9] = this.edgeBandOuter;
      u[10] = edgeBandInner;
      u[11] = this.cellCount;

      u[12] = BLUR_PX;
      u[13] = 0;
      u[14] = 0;
      u[15] = 0;

      u[16] = this.fadeColor.r;
      u[17] = this.fadeColor.g;
      u[18] = this.fadeColor.b;
      u[19] = 1.0;

      this.device.queue.writeBuffer(this.uniformBuffer, 0, u);
    }

    composeToFeedback(encoder, elapsedSec) {
      if (!this.composePipeline) return;

      this._resizeTexturesIfNeeded(false);
      this._writeUniforms(elapsedSec);

      const writeView = this._feedbackWrite().createView();
      const composePass = encoder.beginRenderPass({
        colorAttachments: [{
          view: writeView,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store"
        }]
      });
      composePass.setPipeline(this.composePipeline);
      composePass.setBindGroup(0, this.composeBindGroup);
      composePass.draw(3, 1, 0, 0);
      composePass.end();
    }

    presentToSwapchain(encoder, swapchainView) {
      if (!this.presentPipeline) return;

      const presentPass = encoder.beginRenderPass({
        colorAttachments: [{
          view: swapchainView,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store"
        }]
      });
      presentPass.setPipeline(this.presentPipeline);
      presentPass.setBindGroup(0, this.presentBindGroup);
      presentPass.draw(3, 1, 0, 0);
      presentPass.end();
    }

    setSettings(partial) {
      if (!partial || typeof partial !== "object") return;
      if (typeof partial.fadeColorFollowsBackground === "boolean") {
        this.fadeColorFollowsBackground = partial.fadeColorFollowsBackground;
      }
      if (typeof partial.fadeColor === "string") {
        const hex = partial.fadeColor.trim();
        if (/^#[0-9a-f]{6}$/i.test(hex)) {
          const r = parseInt(hex.slice(1, 3), 16) / 255;
          const g = parseInt(hex.slice(3, 5), 16) / 255;
          const b = parseInt(hex.slice(5, 7), 16) / 255;
          this.setFadeColor(r, g, b);
        }
      }
      const num = (v, cur) => (typeof v === "number" && Number.isFinite(v) ? v : cur);
      if ("cellCount" in partial) this.cellCount = num(partial.cellCount, this.cellCount);
      if ("radialSpeed" in partial) this.radialSpeed = num(partial.radialSpeed, this.radialSpeed);
      if ("edgeSpeed" in partial) this.edgeSpeed = num(partial.edgeSpeed, this.edgeSpeed);
      if ("edgeBandOuter" in partial) this.edgeBandOuter = num(partial.edgeBandOuter, this.edgeBandOuter);
      if ("speedScale" in partial) this.speedScale = num(partial.speedScale, this.speedScale);
    }

    getSettingsSnapshot() {
      const c = this.fadeColor;
      const byte = (x) => Math.round(Math.min(255, Math.max(0, Number(x) * 255)))
        .toString(16)
        .padStart(2, "0");
      return {
        fadeColor: "#" + byte(c.r) + byte(c.g) + byte(c.b),
        fadeColorFollowsBackground: this.fadeColorFollowsBackground,
        cellCount: this.cellCount,
        radialSpeed: this.radialSpeed,
        edgeSpeed: this.edgeSpeed,
        edgeBandOuter: this.edgeBandOuter,
        speedScale: this.speedScale
      };
    }

    getParameterDescriptors() {
      return {
        title: "Stained-glass cells",
        params: [
          {
            key: "cellCount",
            label: "Cell count (across min dimension)",
            type: "range",
            min: 6,
            max: 24,
            step: 1
          },
          {
            key: "radialSpeed",
            label: "Centre-out speed (px/s)",
            type: "range",
            min: 10,
            max: 200,
            step: 1
          },
          {
            key: "edgeSpeed",
            label: "Edge flow speed (px/s)",
            type: "range",
            min: 10,
            max: 200,
            step: 1
          },
          {
            key: "edgeBandOuter",
            label: "Edge band width (fraction of half-cell)",
            type: "range",
            min: 0.08,
            max: 0.4,
            step: 0.01
          },
          {
            key: "speedScale",
            label: "Global speed scale",
            type: "range",
            min: 0.2,
            max: 2.5,
            step: 0.05
          }
        ]
      };
    }
  }

  window.StainedGlassCellEffect = StainedGlassCellEffect;
})();
