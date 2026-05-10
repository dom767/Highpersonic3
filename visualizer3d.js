(() => {
  const DEFAULT_FADE_COLOR = { r: 0.965, g: 0.96, b: 0.985 };

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

      this.backgrounds = new Map();
      this.foregrounds = new Map();
      this.background = null;
      this.foreground = null;
      this.currentBackground = null;
      this.currentForeground = null;
      this.feedbackEffect = "none";
      this.fgInFeedback = true;
      this.fadeColor = { ...DEFAULT_FADE_COLOR };
      this.zoomPost = null;

      this.primaryTexture = null;
      this.primaryTextureUrl = null;

      this.running = false;
      this.paused = false;
      this.pauseStartedAt = 0;
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
        alphaMode: "opaque"
      });

      if (typeof CircularWaveBackground === "function") {
        const circularWave = new CircularWaveBackground({ canvas: this.canvas });
        circularWave.init(this.device, this.format);
        this.backgrounds.set("circularWave", circularWave);
      }
      if (typeof GridCellsBackground === "function") {
        const gridCells = new GridCellsBackground({ canvas: this.canvas });
        gridCells.init(this.device, this.format);
        this.backgrounds.set("gridCells", gridCells);
      }

      if (typeof FullscreenZoomEffect === "function") {
        this.zoomPost = new FullscreenZoomEffect();
        this.zoomPost.setFadeColor(this.fadeColor.r, this.fadeColor.g, this.fadeColor.b);
        this.zoomPost.init(this.device, this.format, this.canvas);
      }

      const wireframe = new GridWireframeRenderer(this.device, this.format);
      wireframe.init();
      this.foregrounds.set("wireframeGrid", wireframe);
      if (typeof DRingsRenderer === "function") {
        const dRings = new DRingsRenderer(this.device, this.format);
        dRings.init();
        this.foregrounds.set("dRings", dRings);
      }

      this.setBackground("none");
      this.setForeground("wireframeGrid");

      this.resize();
      window.addEventListener("resize", this._resizeListener);
      return true;
    }

    setBackground(name) {
      if (this.background && typeof this.background.onDeactivate === "function") {
        this.background.onDeactivate();
      }
      if (name === "none") {
        this.currentBackground = "none";
        this.background = null;
        return true;
      }
      if (!this.backgrounds.has(name)) return false;
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
      if (this.foreground && typeof this.foreground.setSustain === "function") {
        this.foreground.setSustain(this.bassSustain, this.trebleSustain);
      }
      return true;
    }

    setFeedbackEffect(name) {
      const next = name === "zoom" ? "zoom" : "none";
      if (next !== this.feedbackEffect && next === "zoom" && this.zoomPost) {
        this.zoomPost.reset();
      }
      this.feedbackEffect = next;
      return true;
    }

    setFadeColor(r, g, b) {
      this.fadeColor = { r, g, b };
      if (this.zoomPost) {
        this.zoomPost.setFadeColor(r, g, b);
      }
    }

    setFgInFeedback(enabled) {
      this.fgInFeedback = !!enabled;
    }

    _destroyPrimaryTexture() {
      if (this.primaryTexture) {
        this.primaryTexture.destroy();
        this.primaryTexture = null;
      }
      this.primaryTextureUrl = null;
    }

    _randomUnitRgb() {
      return {
        r: Math.random(),
        g: Math.random(),
        b: Math.random(),
        a: 1.0
      };
    }

    _applyRandomPaletteToGridCells() {
      const grid = this.backgrounds.get("gridCells");
      if (!grid || typeof grid.setPrimary !== "function") return;
      const a = this._randomUnitRgb();
      const b = this._randomUnitRgb();
      grid.setPrimary(a);
      grid.setSecondary(b);
    }

    _resetGridCellsPalette() {
      const grid = this.backgrounds.get("gridCells");
      if (!grid || !window.GridCellsBackground) return;
      const D = window.GridCellsBackground;
      grid.setPrimary({ ...D.DEFAULT_PRIMARY });
      grid.setSecondary({ ...D.DEFAULT_SECONDARY });
    }

    /**
     * Loads an image as the primary GPU texture (for upcoming shader use) and,
     * for now, assigns random primary/secondary colors to the spectrum grid.
     * Pass null to clear.
     */
    async setPrimaryTextureAsset(url) {
      if (!this.device) return false;

      if (!url || String(url).trim() === "") {
        this._destroyPrimaryTexture();
        this._resetGridCellsPalette();
        return true;
      }

      const src = String(url).trim();
      let bitmap;
      try {
        const res = await fetch(src);
        if (!res.ok) throw new Error("HTTP " + res.status);
        const blob = await res.blob();
        bitmap = await createImageBitmap(blob);
      } catch (err) {
        throw new Error(err.message || String(err));
      }

      const w = bitmap.width;
      const h = bitmap.height;
      if (w < 1 || h < 1) {
        bitmap.close();
        throw new Error("Invalid image size");
      }

      this._destroyPrimaryTexture();

      const texture = this.device.createTexture({
        size: [w, h],
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.TEXTURE_BINDING
          | GPUTextureUsage.COPY_DST
          | GPUTextureUsage.RENDER_ATTACHMENT
      });

      this.device.queue.copyExternalImageToTexture(
        { source: bitmap },
        { texture },
        [w, h]
      );
      bitmap.close();

      this.primaryTexture = texture;
      this.primaryTextureUrl = src;
      this._applyRandomPaletteToGridCells();
      return true;
    }

    getPrimaryTexture() {
      return this.primaryTexture;
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
      if (this.zoomPost && typeof this.zoomPost.resize === "function") {
        this.zoomPost.resize();
      }
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
      if (this.foreground && typeof this.foreground.setSustain === "function") {
        this.foreground.setSustain(this.bassSustain, this.trebleSustain);
      }
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
      this.paused = false;
      this.pauseStartedAt = 0;
      this.startTime = performance.now();
      this.camera.resetMotion();
      this._loop();
    }

    stop() {
      this.running = false;
      this.paused = false;
      this.pauseStartedAt = 0;
      this.camera.resetMotion();
    }

    setPaused(paused) {
      const shouldPause = !!paused;
      if (!this.running) {
        this.paused = shouldPause;
        this.pauseStartedAt = 0;
        return;
      }
      if (shouldPause === this.paused) return;

      if (shouldPause) {
        this.paused = true;
        this.pauseStartedAt = performance.now();
        return;
      }

      const now = performance.now();
      if (this.pauseStartedAt > 0) {
        this.startTime += now - this.pauseStartedAt;
      }
      this.pauseStartedAt = 0;
      this.paused = false;
    }

    isPaused() {
      return this.paused;
    }

    _loop() {
      if (!this.running) return;
      if (!this.paused) this._render();
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

      if (this.background && typeof this.background.setAudioFrame === "function") {
        this.background.setAudioFrame(this.latestAudioFrame);
      }

      const encoder = this.device.createCommandEncoder();
      const swapchainView = this.context.getCurrentTexture().createView();
      const depthView = this.depthTexture.createView();
      const fc = this.fadeColor;
      const clearColor = { r: fc.r, g: fc.g, b: fc.b, a: 1.0 };
      const useFeedback = this.feedbackEffect === "zoom" && this.zoomPost;

      if (useFeedback) {
        this.zoomPost.composeToFeedback(encoder);

        const fbWriteView = this.zoomPost.getFeedbackWriteView();

        const scenePass = encoder.beginRenderPass({
          colorAttachments: [{
            view: fbWriteView,
            loadOp: "load",
            storeOp: "store"
          }],
          depthStencilAttachment: {
            view: depthView,
            depthClearValue: 1.0,
            depthLoadOp: "clear",
            depthStoreOp: "store"
          }
        });

        if (this.background && typeof this.background.draw === "function") {
          this.background.draw(scenePass, viewProj, elapsed);
        }
        if (this.fgInFeedback && this.foreground && typeof this.foreground.draw === "function") {
          this.foreground.draw(scenePass, viewProj, elapsed);
        }

        scenePass.end();

        this.zoomPost.presentToSwapchain(encoder, swapchainView);

        if (!this.fgInFeedback && this.foreground && typeof this.foreground.draw === "function") {
          const fgPass = encoder.beginRenderPass({
            colorAttachments: [{
              view: swapchainView,
              loadOp: "load",
              storeOp: "store"
            }],
            depthStencilAttachment: {
              view: depthView,
              depthClearValue: 1.0,
              depthLoadOp: "clear",
              depthStoreOp: "store"
            }
          });
          this.foreground.draw(fgPass, viewProj, elapsed);
          fgPass.end();
        }

        this.zoomPost.flipFeedback();
      } else {
        const pass = encoder.beginRenderPass({
          colorAttachments: [{
            view: swapchainView,
            clearValue: clearColor,
            loadOp: "clear",
            storeOp: "store"
          }],
          depthStencilAttachment: {
            view: depthView,
            depthClearValue: 1.0,
            depthLoadOp: "clear",
            depthStoreOp: "store"
          }
        });

        if (this.background && typeof this.background.draw === "function") {
          this.background.draw(pass, viewProj, elapsed);
        }
        if (this.foreground && typeof this.foreground.draw === "function") {
          this.foreground.draw(pass, viewProj, elapsed);
        }

        pass.end();
      }

      this.device.queue.submit([encoder.finish()]);
    }
  }

  Visualizer3D.GRID_SIZE = GridWireframeRenderer.GRID_SIZE;
  Visualizer3D.GRID_DEPTH = GridWireframeRenderer.GRID_DEPTH;
  window.Visualizer3D = Visualizer3D;
})();
