(() => {
  const ZOOM = 1.02;
  const FADE = 0.997;
  const BLUR_PX = 1.0;

  const COMPOSE_SHADER = /* wgsl */`
    struct Uniforms {
      params: vec4<f32>,
      blurPad: vec4<f32>,
      fadeColor: vec4<f32>,
    };

    struct VSOut {
      @builtin(position) position: vec4<f32>,
      @location(0) uv: vec2<f32>,
    };

    @group(0) @binding(0) var<uniform> uni: Uniforms;
    @group(0) @binding(1) var samp: sampler;
    @group(0) @binding(2) var prevTex: texture_2d<f32>;

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

    fn sampleZoomedPrev(uv: vec2<f32>, zoom: f32) -> vec4<f32> {
      let c = vec2<f32>(0.5, 0.5);
      let q = (uv - c) / zoom;
      return textureSample(prevTex, samp, c + q);
    }

    fn blurPrev(uv: vec2<f32>, canvasPx: vec2<f32>, blurPx: f32, zoom: f32) -> vec4<f32> {
      let px = blurPx / canvasPx;
      let w0 = 0.227027;
      let w1 = 0.316216;
      let w2 = 0.070270;
      let total = w0 + 4.0 * w1 + 4.0 * w2;
      var acc = sampleZoomedPrev(uv, zoom) * w0;
      acc += sampleZoomedPrev(uv + vec2<f32>(px.x, 0.0), zoom) * w1;
      acc += sampleZoomedPrev(uv - vec2<f32>(px.x, 0.0), zoom) * w1;
      acc += sampleZoomedPrev(uv + vec2<f32>(2.0 * px.x, 0.0), zoom) * w2;
      acc += sampleZoomedPrev(uv - vec2<f32>(2.0 * px.x, 0.0), zoom) * w2;
      acc += sampleZoomedPrev(uv + vec2<f32>(0.0, px.y), zoom) * w1;
      acc += sampleZoomedPrev(uv - vec2<f32>(0.0, px.y), zoom) * w1;
      acc += sampleZoomedPrev(uv + vec2<f32>(0.0, 2.0 * px.y), zoom) * w2;
      acc += sampleZoomedPrev(uv - vec2<f32>(0.0, 2.0 * px.y), zoom) * w2;
      return acc / total;
    }

    fn quantizedFadeStep(current: f32, targetValue: f32, fade: f32) -> f32 {
      let mixed = mix(targetValue, current, fade);
      let curByte = i32(round(clamp(current, 0.0, 1.0) * 255.0));
      let tgtByte = i32(round(clamp(targetValue, 0.0, 1.0) * 255.0));
      var outByte = i32(round(clamp(mixed, 0.0, 1.0) * 255.0));

      // Guarantee progress in 8-bit space when still off-target.
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
      let canvasPx = uni.params.xy;
      let zoom = uni.params.z;
      let fade = uni.params.w;
      let blurPx = uni.blurPad.x;
      let blurred = blurPrev(uv, canvasPx, blurPx, zoom);
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
    };

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

  class FullscreenZoomEffect {
    constructor() {
      this.device = null;
      this.format = null;
      this.canvas = null;
      this.sampler = null;
      this.uniformBuffer = null;
      this.uniformData = new Float32Array(12);
      this.fadeColor = { r: 0.965, g: 0.96, b: 0.985 };
      /** When true, fade target RGB tracks the scene clear colour (set from Visualizer3D). */
      this.fadeColorFollowsBackground = false;
      /** When set, feedback textures are cleared to this RGB (palette secondary); falls back to fadeColor. */
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
        size: 48,
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

    /** Clears feedback ping-pong buffers to match scene background (e.g. palette secondary). */
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
      this._resizeTexturesIfNeeded(true);
    }

    getFeedbackWriteView() {
      return this._feedbackWrite() ? this._feedbackWrite().createView() : null;
    }

    flipFeedback() {
      this.readIndex = 1 - this.readIndex;
      this._rebuildBindGroups();
    }

    _writeUniforms() {
      const w = this.canvas.width || 1;
      const h = this.canvas.height || 1;
      this.uniformData[0] = w;
      this.uniformData[1] = h;
      this.uniformData[2] = ZOOM;
      this.uniformData[3] = FADE;
      this.uniformData[4] = BLUR_PX;
      this.uniformData[5] = 0;
      this.uniformData[6] = 0;
      this.uniformData[7] = 0;
      this.uniformData[8] = this.fadeColor.r;
      this.uniformData[9] = this.fadeColor.g;
      this.uniformData[10] = this.fadeColor.b;
      this.uniformData[11] = 1.0;
      this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);
    }

    composeToFeedback(encoder) {
      if (!this.composePipeline) return;

      this._resizeTexturesIfNeeded(false);
      this._writeUniforms();

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
    }

    getSettingsSnapshot() {
      const c = this.fadeColor;
      const byte = (x) => Math.round(Math.min(255, Math.max(0, Number(x) * 255)))
        .toString(16)
        .padStart(2, "0");
      return {
        fadeColor: "#" + byte(c.r) + byte(c.g) + byte(c.b),
        fadeColorFollowsBackground: this.fadeColorFollowsBackground
      };
    }

    getParameterDescriptors() {
      return {
        title: "Feedback zoom",
        params: [
          {
            key: "fadeColorFollowsBackground",
            label: "Use scene background colour",
            type: "checkbox"
          },
          { key: "fadeColor", label: "Fade colour", type: "color" }
        ]
      };
    }
  }

  window.FullscreenZoomEffect = FullscreenZoomEffect;
})();
