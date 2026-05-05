(() => {
  class Visualizer3D {
    static isSupported() {
      return typeof navigator !== "undefined" && !!navigator.gpu;
    }

    constructor() {
      this.canvas = null;
      this.device = null;
      this.context = null;
      this.format = null;
      this.depthTexture = null;
      this.renderer = null;
      this.currentMode = "wireframeGrid";
      this.visualizers = new Map();

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

      const wireframe = new GridWireframeRenderer(this.device, this.format);
      wireframe.init();
      this.visualizers.set("wireframeGrid", wireframe);
      this.renderer = wireframe;

      this.resize();
      window.addEventListener("resize", this._resizeListener);
      return true;
    }

    setMode(mode) {
      if (!this.visualizers.has(mode)) return false;
      this.currentMode = mode;
      this.renderer = this.visualizers.get(mode);
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
      if (!this.renderer || !spectrum32) return;
      this.renderer.pushSpectrum(spectrum32);
    }

    clearHistory() {
      if (!this.renderer) return;
      this.renderer.clearHistory();
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

    _render() {
      this.resize();
      if (!this.renderer) return;
      const elapsed = (performance.now() - this.startTime) / 1000;
      const aspect = this.canvas.width / Math.max(1, this.canvas.height);
      const viewProj = this.camera.getViewProjection(elapsed, aspect);

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

      this.renderer.draw(pass, viewProj, elapsed);
      pass.end();

      this.device.queue.submit([encoder.finish()]);
    }
  }

  Visualizer3D.GRID_SIZE = GridWireframeRenderer.GRID_SIZE;
  Visualizer3D.GRID_DEPTH = GridWireframeRenderer.GRID_DEPTH;
  window.Visualizer3D = Visualizer3D;
})();
