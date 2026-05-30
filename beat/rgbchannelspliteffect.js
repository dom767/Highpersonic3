(() => {
  const DEFAULT_MAX_OFFSET_PX = 40;
  const DEFAULT_DECAY_RATE = 10;
  const OFFSET_EPSILON = 0.5;

  const RGB_SPLIT_SHADER = /* wgsl */`
    struct Uniforms {
      canvasSize: vec2<f32>,
      offsetPx: f32,
      pad: f32,
    };

    struct VSOut {
      @builtin(position) position: vec4<f32>,
      @location(0) uv: vec2<f32>,
    };

    @group(0) @binding(0) var<uniform> uni: Uniforms;
    @group(0) @binding(1) var samp: sampler;
    @group(0) @binding(2) var srcTex: texture_2d<f32>;

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

    fn offsetUv(angleRad: f32, offsetPx: f32, canvasSize: vec2<f32>) -> vec2<f32> {
      let dir = vec2<f32>(cos(angleRad), sin(angleRad));
      return (offsetPx * dir) / canvasSize;
    }

    fn clampUv(uv: vec2<f32>) -> vec2<f32> {
      return vec2<f32>(clamp(uv.x, 0.0, 1.0), clamp(uv.y, 0.0, 1.0));
    }

    @fragment
    fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
      let tauThird = 2.094395102;
      let px = uni.offsetPx;
      let size = uni.canvasSize;

      let rSample = clampUv(uv + offsetUv(0.0, px, size));
      let gSample = clampUv(uv + offsetUv(tauThird, px, size));
      let bSample = clampUv(uv + offsetUv(2.0 * tauThird, px, size));

      let r = textureSample(srcTex, samp, rSample).r;
      let g = textureSample(srcTex, samp, gSample).g;
      let b = textureSample(srcTex, samp, bSample).b;
      let a = textureSample(srcTex, samp, uv).a;
      return vec4<f32>(r, g, b, a);
    }
  `;

  class RgbChannelSplitEffect {
    constructor() {
      this.device = null;
      this.format = null;
      this.canvas = null;

      this.maxOffsetPx = DEFAULT_MAX_OFFSET_PX;
      this.decayRate = DEFAULT_DECAY_RATE;
      this.currentOffsetPx = 0;

      this.resolveTexture = null;
      this.resolveWidth = 0;
      this.resolveHeight = 0;

      this.uniformBuffer = null;
      this.uniformData = new Float32Array(4);
      this.sampler = null;
      this.pipeline = null;
      this.bindGroupLayout = null;
      this.bindGroup = null;
    }

    init(device, format, canvas) {
      this.device = device;
      this.format = format;
      this.canvas = canvas;

      this.sampler = device.createSampler({
        magFilter: "linear",
        minFilter: "linear"
      });

      this.uniformBuffer = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });

      const module = device.createShaderModule({ code: RGB_SPLIT_SHADER });
      this.bindGroupLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} }
        ]
      });

      const pipelineLayout = device.createPipelineLayout({
        bindGroupLayouts: [this.bindGroupLayout]
      });

      this.pipeline = device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module, entryPoint: "vs_main" },
        fragment: {
          module,
          entryPoint: "fs_main",
          targets: [{ format }]
        },
        primitive: { topology: "triangle-list" }
      });

      this._resizeResolveIfNeeded(true);
    }

    _resizeResolveIfNeeded(force) {
      if (!this.device || !this.canvas) return;
      const w = this.canvas.width || 1;
      const h = this.canvas.height || 1;
      const needRebuild = force || !this.resolveTexture
        || this.resolveWidth !== w || this.resolveHeight !== h;
      if (!needRebuild) return;

      if (this.resolveTexture) this.resolveTexture.destroy();

      this.resolveTexture = this.device.createTexture({
        size: [w, h],
        format: this.format,
        usage: GPUTextureUsage.TEXTURE_BINDING
          | GPUTextureUsage.RENDER_ATTACHMENT
      });
      this.resolveWidth = w;
      this.resolveHeight = h;
      this._rebuildBindGroup();
    }

    _rebuildBindGroup() {
      if (!this.device || !this.resolveTexture || !this.bindGroupLayout) return;
      this.bindGroup = this.device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: this.resolveTexture.createView() }
        ]
      });
    }

    resize() {
      this._resizeResolveIfNeeded(false);
    }

    reset() {
      this.currentOffsetPx = 0;
    }

    trigger() {
      this.currentOffsetPx = this.maxOffsetPx;
    }

    update(dt) {
      const dtSec = Math.max(0, Number(dt) || 0);
      if (this.currentOffsetPx <= OFFSET_EPSILON) {
        this.currentOffsetPx = 0;
        return;
      }
      this.currentOffsetPx *= Math.exp(-this.decayRate * dtSec);
      if (this.currentOffsetPx < OFFSET_EPSILON) {
        this.currentOffsetPx = 0;
      }
    }

    getOffsetPx() {
      return this.currentOffsetPx;
    }

    getRenderTargetView() {
      this._resizeResolveIfNeeded(false);
      return this.resolveTexture ? this.resolveTexture.createView() : null;
    }

    _writeUniforms() {
      const w = this.canvas?.width || 1;
      const h = this.canvas?.height || 1;
      this.uniformData[0] = w;
      this.uniformData[1] = h;
      this.uniformData[2] = this.currentOffsetPx;
      this.uniformData[3] = 0;
      this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);
    }

    presentToSwapchain(encoder, swapchainView) {
      if (!this.pipeline || !this.resolveTexture || !this.bindGroup) return;

      this._resizeResolveIfNeeded(false);
      this._writeUniforms();

      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: swapchainView,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store"
        }]
      });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.bindGroup);
      pass.draw(3, 1, 0, 0);
      pass.end();
    }

    setSettings(partial) {
      if (!partial || typeof partial !== "object") return;
      if (typeof partial.maxOffsetPx === "number") {
        this.maxOffsetPx = Math.max(0, Math.min(200, partial.maxOffsetPx));
      }
      if (typeof partial.decayRate === "number") {
        this.decayRate = Math.max(1, Math.min(30, partial.decayRate));
      }
    }

    getSettingsSnapshot() {
      return {
        maxOffsetPx: this.maxOffsetPx,
        decayRate: this.decayRate
      };
    }

    getParameterDescriptors() {
      return {
        title: "RGB channel split",
        params: [
          {
            key: "maxOffsetPx",
            label: "Max shift (px)",
            type: "range",
            min: 0,
            max: 200,
            step: 1
          },
          {
            key: "decayRate",
            label: "Decay speed (1/s)",
            type: "range",
            min: 1,
            max: 30,
            step: 0.5
          }
        ]
      };
    }
  }

  window.RgbChannelSplitEffect = RgbChannelSplitEffect;
})();
