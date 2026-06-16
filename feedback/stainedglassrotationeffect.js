(() => {
  const FADE = 0.995;
  const BLUR_PX = 0.65;
  /** Base clockwise rotation rate (rad/s); modulated per-pixel for stained-glass look. */
  const BASE_RAD_PER_SEC = 0.4;
  const RADIAL_MIX = 0.55;
  const RING_MIX = 0.28;
  const CELL_MIX = 0.2;
  const RING_BANDS = 14;
  const CELL_DIVISIONS = 10;
  const RADIAL_WAVE_FREQ = 5.5;

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

    fn aspect_centered(uv: vec2<f32>) -> vec2<f32> {
      let w = uni.canvasAndTime.x;
      let h = uni.canvasAndTime.y;
      let aspect = w / max(h, 1.0);
      return vec2<f32>((uv.x - 0.5) * 2.0 * aspect, (uv.y - 0.5) * 2.0);
    }

    fn uv_from_centered(p: vec2<f32>) -> vec2<f32> {
      let w = uni.canvasAndTime.x;
      let h = uni.canvasAndTime.y;
      let aspect = w / max(h, 1.0);
      return vec2<f32>(p.x / (2.0 * aspect) + 0.5, p.y * 0.5 + 0.5);
    }

    fn stained_glass_omega(r: f32, th: f32) -> f32 {
      let base = uni.rates.y;
      let radialMix = uni.rates.z;
      let ringMix = uni.rates.w;
      let cellMix = uni.pattern.x;
      let ringBands = uni.pattern.y;
      let cellDiv = uni.pattern.z;
      let radialFreq = uni.pattern.w;

      let radialWave = sin(r * radialFreq * 6.28318530718);
      let ringRipple = sin(r * ringBands * 6.28318530718 * 0.85);
      let cellA = sin(th * cellDiv + r * 11.17);
      let cellB = cos(th * 5.23 - r * 9.41);
      let cellC = sin(th * 3.7 + r * r * 6.0);
      let glass = cellA * cellB * 0.5 + cellC * 0.35;

      let wobble = radialMix * radialWave + ringMix * ringRipple + cellMix * glass;
      return base * (1.0 + clamp(wobble, -0.92, 2.5));
    }

    fn sample_rotated_prev(uv: vec2<f32>, angleRad: f32) -> vec4<f32> {
      let p = aspect_centered(uv);
      let r = length(p);
      let th = atan2(p.y, p.x);
      let th_s = th - angleRad;
      let ps = vec2<f32>(r * cos(th_s), r * sin(th_s));
      let uvs = uv_from_centered(ps);
      return textureSampleLevel(prevTex, samp, uvs, 0.0);
    }

    fn blur_rotated(uv: vec2<f32>, canvasPx: vec2<f32>, blurPx: f32, angleRad: f32) -> vec4<f32> {
      let px = blurPx / canvasPx;
      let w0 = 0.227027;
      let w1 = 0.316216;
      let w2 = 0.070270;
      let total = w0 + 4.0 * w1 + 4.0 * w2;
      var acc = sample_rotated_prev(uv, angleRad) * w0;
      acc += sample_rotated_prev(uv + vec2<f32>(px.x, 0.0), angleRad) * w1;
      acc += sample_rotated_prev(uv - vec2<f32>(px.x, 0.0), angleRad) * w1;
      acc += sample_rotated_prev(uv + vec2<f32>(2.0 * px.x, 0.0), angleRad) * w2;
      acc += sample_rotated_prev(uv - vec2<f32>(2.0 * px.x, 0.0), angleRad) * w2;
      acc += sample_rotated_prev(uv + vec2<f32>(0.0, px.y), angleRad) * w1;
      acc += sample_rotated_prev(uv - vec2<f32>(0.0, px.y), angleRad) * w1;
      acc += sample_rotated_prev(uv + vec2<f32>(0.0, 2.0 * px.y), angleRad) * w2;
      acc += sample_rotated_prev(uv - vec2<f32>(0.0, 2.0 * px.y), angleRad) * w2;
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

      let p = aspect_centered(uv);
      let r = length(p);
      let th = atan2(p.y, p.x);
      let omega = stained_glass_omega(r, th);
      let angleRad = omega * dt;

      let blurred = blur_rotated(uv, canvasPx, blurPx, angleRad);
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

  class StainedGlassRotationEffect {
    constructor() {
      this.device = null;
      this.format = null;
      this.canvas = null;
      this.sampler = null;
      this.uniformBuffer = null;
      /** 20 floats: 5 vec4 */
      this.uniformData = new Float32Array(20);
      this.fadeColor = { r: 0.965, g: 0.96, b: 0.985 };
      // Keep fade colour bound to scene background (texture secondary) by default.
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

      this.baseRadPerSec = BASE_RAD_PER_SEC;
      this.radialMix = RADIAL_MIX;
      this.ringMix = RING_MIX;
      this.cellMix = CELL_MIX;
      this.ringBands = RING_BANDS;
      this.cellDivisions = CELL_DIVISIONS;
      this.radialWaveFreq = RADIAL_WAVE_FREQ;
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

      const u = this.uniformData;
      u[0] = w;
      u[1] = h;
      u[2] = typeof elapsedSec === "number" ? elapsedSec : 0;
      u[3] = dt;

      u[4] = FADE;
      u[5] = this.baseRadPerSec;
      u[6] = this.radialMix;
      u[7] = this.ringMix;

      u[8] = this.cellMix;
      u[9] = this.ringBands;
      u[10] = this.cellDivisions;
      u[11] = this.radialWaveFreq;

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
      if ("baseRadPerSec" in partial) this.baseRadPerSec = num(partial.baseRadPerSec, this.baseRadPerSec);
      if ("radialMix" in partial) this.radialMix = num(partial.radialMix, this.radialMix);
      if ("ringMix" in partial) this.ringMix = num(partial.ringMix, this.ringMix);
      if ("cellMix" in partial) this.cellMix = num(partial.cellMix, this.cellMix);
      if ("ringBands" in partial) this.ringBands = num(partial.ringBands, this.ringBands);
      if ("cellDivisions" in partial) this.cellDivisions = num(partial.cellDivisions, this.cellDivisions);
      if ("radialWaveFreq" in partial) this.radialWaveFreq = num(partial.radialWaveFreq, this.radialWaveFreq);
    }

    getSettingsSnapshot() {
      const c = this.fadeColor;
      const byte = (x) => Math.round(Math.min(255, Math.max(0, Number(x) * 255)))
        .toString(16)
        .padStart(2, "0");
      return {
        fadeColor: "#" + byte(c.r) + byte(c.g) + byte(c.b),
        fadeColorFollowsBackground: this.fadeColorFollowsBackground,
        baseRadPerSec: this.baseRadPerSec,
        radialMix: this.radialMix,
        ringMix: this.ringMix,
        cellMix: this.cellMix,
        ringBands: this.ringBands,
        cellDivisions: this.cellDivisions,
        radialWaveFreq: this.radialWaveFreq
      };
    }

    getParameterDescriptors() {
      return {
        title: "Stained-glass rotation",
        params: [
          {
            key: "baseRadPerSec",
            label: "Rotation speed (rad/s, negative flips direction)",
            type: "range",
            min: -1.6,
            max: 1.6,
            step: 0.01
          },
          {
            key: "radialMix",
            label: "Radial variation",
            type: "range",
            min: 0,
            max: 1,
            step: 0.01
          },
          {
            key: "ringMix",
            label: "Ring (circumference) variation",
            type: "range",
            min: 0,
            max: 1,
            step: 0.01
          },
          {
            key: "cellMix",
            label: "Angular cell variation",
            type: "range",
            min: 0,
            max: 1,
            step: 0.01
          },
          {
            key: "ringBands",
            label: "Ring bands",
            type: "range",
            min: 4,
            max: 32,
            step: 1
          },
          {
            key: "cellDivisions",
            label: "Cell divisions",
            type: "range",
            min: 3,
            max: 24,
            step: 1
          },
          {
            key: "radialWaveFreq",
            label: "Radial waves",
            type: "range",
            min: 2,
            max: 14,
            step: 0.5
          }
        ]
      };
    }
  }

  window.StainedGlassRotationEffect = StainedGlassRotationEffect;
})();
