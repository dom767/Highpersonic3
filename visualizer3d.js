(() => {
  const FALLBACK_CLEAR_VALUE = { r: 0.965, g: 0.96, b: 0.985, a: 1.0 };

  class Visualizer3D {
    static isSupported() {
      return typeof navigator !== "undefined" && !!navigator.gpu;
    }

    constructor(options = {}) {
      this.canvas = null;
      this.backgroundCanvas = options.backgroundCanvas || null;
      this.device = null;
      this.context = null;
      this.format = null;
      this.depthTexture = null;

      this.backgrounds = new Map();
      this.foregrounds = new Map();
      this.background = null;
      this.foreground = null;
      this.currentBackground = null;
      this.currentForeground = null;

      this.running = false;
      this.startTime = 0;
      this.camera = new OrbitCamera();
      this.bassSustain = 0;
      this.trebleSustain = 0;
      this.latestAudioFrame = null;
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

      const solidColor = new SolidColorBackground();
      solidColor.init(this.device, this.format);
      this.backgrounds.set("solidColor", solidColor);
      const blackBackground = new SolidColorBackground({ r: 0, g: 0, b: 0, a: 1 });
      blackBackground.init(this.device, this.format);
      this.backgrounds.set("black", blackBackground);
      if (this.backgroundCanvas && typeof CircularWaveBackground === "function") {
        const circularWave = new CircularWaveBackground(this.backgroundCanvas);
        circularWave.init(this.device, this.format);
        this.backgrounds.set("circularWave", circularWave);
      }

      const wireframe = new GridWireframeRenderer(this.device, this.format);
      wireframe.init();
      this.foregrounds.set("wireframeGrid", wireframe);

      this.setBackground("solidColor");
      this.setForeground("wireframeGrid");

      this.resize();
      window.addEventListener("resize", this._resizeListener);
      return true;
    }

    setBackground(name) {
      if (!this.backgrounds.has(name)) return false;
      if (this.background && typeof this.background.onDeactivate === "function") {
        this.background.onDeactivate();
      }
      this.currentBackground = name;
      this.background = this.backgrounds.get(name);
      if (this.background && typeof this.background.onActivate === "function") {
        this.background.onActivate();
      }
      return true;
    }

    setForeground(name) {
      if (!this.foregrounds.has(name)) return false;
      this.currentForeground = name;
      this.foreground = this.foregrounds.get(name);
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
      if (this.background && typeof this.background.resize === "function") {
        this.background.resize();
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

    pushSpectrum(sourceSpectrum) {
      if (!this.foreground || !sourceSpectrum) return;
      this.foreground.pushSpectrum(sourceSpectrum);
    }

    clearHistory() {
      if (!this.foreground) return;
      this.foreground.clearHistory();
    }

    setSpectrumSettings(partial) {
      if (!this.foreground || typeof this.foreground.setSettings !== "function") return;
      this.foreground.setSettings(partial);
    }

    setSustain(bassSustain, trebleSustain) {
      this.bassSustain = Math.max(0, Math.min(1, Number(bassSustain) || 0));
      this.trebleSustain = Math.max(0, Math.min(1, Number(trebleSustain) || 0));
    }

    setAudioFrame(frame) {
      this.latestAudioFrame = frame || null;
      if (this.background && typeof this.background.setAudioFrame === "function") {
        this.background.setAudioFrame(this.latestAudioFrame);
      }
    }

    start() {
      if (this.running || !this.device) return;
      this.running = true;
      this.startTime = performance.now();
      this.camera.resetMotion();
      this._loop();
    }

    stop() {
      this.running = false;
      this.camera.resetMotion();
    }

    _loop() {
      if (!this.running) return;
      this._render();
      requestAnimationFrame(() => this._loop());
    }

    _render() {
      this.resize();

      const elapsed = (performance.now() - this.startTime) / 1000;
      const aspect = this.canvas.width / Math.max(1, this.canvas.height);
      const viewProj = this.camera.getViewProjection(elapsed, aspect, {
        bassSustain: this.bassSustain,
        trebleSustain: this.trebleSustain
      });

      const clearValue = this.background
        ? this.background.getClearValue()
        : FALLBACK_CLEAR_VALUE;

      const encoder = this.device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: this.context.getCurrentTexture().createView(),
          clearValue,
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

      if (this.background && typeof this.background.draw === "function") {
        if (typeof this.background.setAudioFrame === "function") {
          this.background.setAudioFrame(this.latestAudioFrame);
        }
        this.background.draw(pass, viewProj, elapsed);
      }
      if (this.foreground && typeof this.foreground.draw === "function") {
        this.foreground.draw(pass, viewProj, elapsed);
      }

      pass.end();
      this.device.queue.submit([encoder.finish()]);
    }
  }

  Visualizer3D.GRID_SIZE = GridWireframeRenderer.GRID_SIZE;
  Visualizer3D.GRID_DEPTH = GridWireframeRenderer.GRID_DEPTH;
  window.Visualizer3D = Visualizer3D;
})();
