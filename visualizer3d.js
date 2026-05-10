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
      /** @type {{ lightDir: number[], ambient: number, diffuse: number } | null} */
      this.sceneLights = null;
      /** Canvas clear / scene base — follows grid palette secondary. */
      this.backgroundClearRgb = { r: 0.78, g: 0.639, b: 0.91 };
      this._resizeListener = () => this.resize();
      /** @type {Set<(snap: { groups: Array<{ scope: string, effectKey: string, title: string, params: object[] }> }) => void>} */
      this._parameterDescriptorListeners = new Set();
    }

    /**
     * Map canvas background to palette secondary and circular-wave line to primary;
     * zoom feedback buffers use the same base clear as secondary when set.
     */
    _syncAppearanceFromGridPalette() {
      const D = typeof window.GridCellsBackground === "function" ? window.GridCellsBackground : null;
      const grid = this.backgrounds.get("gridCells");
      const sec = grid?.secondary ?? (D ? { ...D.DEFAULT_SECONDARY } : this.backgroundClearRgb);
      const prim = grid?.primary ?? (D ? { ...D.DEFAULT_PRIMARY } : { r: 0.961, g: 0.953, b: 1.0 });

      this.backgroundClearRgb = { r: sec.r, g: sec.g, b: sec.b };

      const wave = this.backgrounds.get("circularWave");
      if (wave && typeof wave.setLineColor === "function") {
        wave.setLineColor(prim.r, prim.g, prim.b, 0.95);
      }

      if (this.zoomPost && typeof this.zoomPost.setSceneBackgroundColor === "function") {
        this.zoomPost.setSceneBackgroundColor(sec.r, sec.g, sec.b);
      }
      this._syncZoomFadeColorWithBackground();
    }

    /**
     * When feedback zoom has "fade follows background", keep fade RGB in sync with scene clear colour.
     */
    _syncZoomFadeColorWithBackground() {
      if (!this.zoomPost || this.feedbackEffect !== "zoom") return;
      if (!this.zoomPost.fadeColorFollowsBackground) return;
      const bc = this.backgroundClearRgb;
      this.zoomPost.setFadeColor(bc.r, bc.g, bc.b);
      this.fadeColor = { r: bc.r, g: bc.g, b: bc.b };
    }

    _cloneDefaultSceneLights() {
      const D = typeof window !== "undefined" && window.SceneLightingDefaults;
      const ld = D && D.lightDir ? D.lightDir : [0.46, 0.64, 0.46];
      return {
        lightDir: [ld[0], ld[1], ld[2]],
        ambient: D ? D.ambient : 0.24,
        diffuse: D ? D.diffuse : 0.76
      };
    }

    _pushSceneLightsToAllForegrounds() {
      if (!this.sceneLights) return;
      const state = this.sceneLights;
      for (const fg of this.foregrounds.values()) {
        if (typeof fg.setSceneLights === "function") {
          fg.setSceneLights(state);
        }
      }
    }

    /**
     * Apply lighting from `SceneLightingDefaults` or a partial update. Owned by the visualizer;
     * all foregrounds are updated when values change.
     * @param {{ lightDir?: number[], ambient?: number, diffuse?: number } | null} partial
     * @returns {boolean}
     */
    setSceneLights(partial) {
      if (!this.sceneLights || !partial) return false;
      const L = this.sceneLights;
      if (partial.lightDir && partial.lightDir.length >= 3) {
        L.lightDir[0] = partial.lightDir[0];
        L.lightDir[1] = partial.lightDir[1];
        L.lightDir[2] = partial.lightDir[2];
      }
      if (typeof partial.ambient === "number") L.ambient = partial.ambient;
      if (typeof partial.diffuse === "number") L.diffuse = partial.diffuse;
      this._pushSceneLightsToAllForegrounds();
      return true;
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

      this.sceneLights = this._cloneDefaultSceneLights();
      this._pushSceneLightsToAllForegrounds();
      this._syncPrimaryTextureToAllForegrounds();
      this._syncAppearanceFromGridPalette();

      this.resize();
      window.addEventListener("resize", this._resizeListener);
      this._notifyParameterDescriptors();
      return true;
    }

    /**
     * Subscribe to effect parameter metadata changes (active background / foreground / feedback).
     * Invokes immediately with the current snapshot. Returns an unsubscribe function.
     * @param {(snap: { groups: object[] }) => void} callback
     * @returns {() => void}
     */
    subscribeParameterDescriptors(callback) {
      this._parameterDescriptorListeners.add(callback);
      try {
        callback(this.getParameterDescriptorGroups());
      } catch (err) {
        console.error(err);
      }
      return () => this._parameterDescriptorListeners.delete(callback);
    }

    _notifyParameterDescriptors() {
      const snap = this.getParameterDescriptorGroups();
      for (const cb of this._parameterDescriptorListeners) {
        try {
          cb(snap);
        } catch (err) {
          console.error(err);
        }
      }
    }

    /**
     * Declarative UI metadata for the active visual effects.
     * @returns {{ groups: Array<{ scope: string, effectKey: string, title: string, params: object[] }> }}
     */
    getParameterDescriptorGroups() {
      /** @type {Array<{ scope: string, effectKey: string, title: string, params: object[] }>} */
      const groups = [];
      const push = (scope, effectKey, instance) => {
        if (!instance || typeof instance.getParameterDescriptors !== "function") return;
        const d = instance.getParameterDescriptors();
        if (!d || !Array.isArray(d.params) || d.params.length === 0) return;
        groups.push({
          scope,
          effectKey,
          title: typeof d.title === "string" ? d.title : effectKey,
          params: d.params
        });
      };
      if (this.currentBackground && this.currentBackground !== "none" && this.background) {
        push("background", this.currentBackground, this.background);
      }
      if (this.currentForeground && this.foreground) {
        push("foreground", this.currentForeground, this.foreground);
      }
      if (this.feedbackEffect === "zoom" && this.zoomPost) {
        push("feedback", "zoom", this.zoomPost);
      }
      return { groups };
    }

    /**
     * Apply settings only to the given active effect instance.
     * @param {"foreground"|"background"|"feedback"} scope
     * @param {string} effectKey
     * @param {object} partial
     * @returns {boolean}
     */
    applyEffectSettings(scope, effectKey, partial) {
      if (!partial || typeof partial !== "object") return false;
      let instance = null;
      if (scope === "foreground") {
        if (this.currentForeground !== effectKey) return false;
        instance = this.foreground;
      } else if (scope === "background") {
        if (this.currentBackground !== effectKey) return false;
        instance = this.background;
      } else if (scope === "feedback") {
        if (this.feedbackEffect !== "zoom" || effectKey !== "zoom") return false;
        instance = this.zoomPost;
      }
      if (!instance || typeof instance.setSettings !== "function") return false;
      instance.setSettings(partial);
      if (scope === "feedback" && effectKey === "zoom") {
        this._syncZoomFadeColorWithBackground();
        if (this.zoomPost && this.zoomPost.fadeColor) {
          this.fadeColor = {
            r: this.zoomPost.fadeColor.r,
            g: this.zoomPost.fadeColor.g,
            b: this.zoomPost.fadeColor.b
          };
        }
      }
      return true;
    }

    /**
     * @param {"foreground"|"background"|"feedback"} scope
     * @param {string} effectKey
     * @returns {object | null}
     */
    getEffectSettingsSnapshot(scope, effectKey) {
      let instance = null;
      if (scope === "foreground") {
        if (this.currentForeground !== effectKey) return null;
        instance = this.foreground;
      } else if (scope === "background") {
        if (this.currentBackground !== effectKey) return null;
        instance = this.background;
      } else if (scope === "feedback") {
        if (this.feedbackEffect !== "zoom" || effectKey !== "zoom") return null;
        instance = this.zoomPost;
      }
      if (!instance || typeof instance.getSettingsSnapshot !== "function") return null;
      return instance.getSettingsSnapshot();
    }

    setBackground(name) {
      if (this.background && typeof this.background.onDeactivate === "function") {
        this.background.onDeactivate();
      }
      if (name === "none") {
        this.currentBackground = "none";
        this.background = null;
        this._notifyParameterDescriptors();
        return true;
      }
      if (!this.backgrounds.has(name)) return false;
      this.currentBackground = name;
      this.background = this.backgrounds.get(name);
      if (this.background && typeof this.background.onActivate === "function") {
        this.background.onActivate();
      }
      this._notifyParameterDescriptors();
      return true;
    }

    setForeground(name) {
      if (!this.foregrounds.has(name)) return false;
      this.currentForeground = name;
      this.foreground = this.foregrounds.get(name);
      this._notifyParameterDescriptors();
      return true;
    }

    setFeedbackEffect(name) {
      const next = name === "zoom" ? "zoom" : "none";
      if (next !== this.feedbackEffect && next === "zoom" && this.zoomPost) {
        this.zoomPost.reset();
      }
      this.feedbackEffect = next;
      this._notifyParameterDescriptors();
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

    _syncPrimaryTextureToAllForegrounds() {
      const tex = this.primaryTexture ?? null;
      for (const fg of this.foregrounds.values()) {
        if (typeof fg.setSpectrumTexture === "function") {
          fg.setSpectrumTexture(tex);
        }
      }
    }

    _destroyPrimaryTexture() {
      if (this.primaryTexture) {
        for (const fg of this.foregrounds.values()) {
          if (typeof fg.setSpectrumTexture === "function") {
            fg.setSpectrumTexture(null);
          }
        }
        this.primaryTexture.destroy();
        this.primaryTexture = null;
      }
      this.primaryTextureUrl = null;
    }

    _applyTextureDerivedPaletteToGridCells(primary01, secondary01) {
      const grid = this.backgrounds.get("gridCells");
      if (!grid || typeof grid.setPrimary !== "function") return;
      grid.setPrimary(primary01);
      grid.setSecondary(secondary01);
      this._syncAppearanceFromGridPalette();
    }

    _resetGridCellsPalette() {
      const grid = this.backgrounds.get("gridCells");
      if (!grid || !window.GridCellsBackground) return;
      const D = window.GridCellsBackground;
      grid.setPrimary({ ...D.DEFAULT_PRIMARY });
      grid.setSecondary({ ...D.DEFAULT_SECONDARY });
      this._syncAppearanceFromGridPalette();
    }

    /**
     * Loads an image as the primary GPU texture (for upcoming shader use) and
     * sets spectrum grid primary (mean RGB) and secondary (complementary hue + texture S/L).
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

      const derive =
        typeof window.TexturePalette !== "undefined" && window.TexturePalette.deriveFromBitmap;
      const { primary, secondary } = derive
        ? derive(bitmap)
        : {
          primary: { r: 0.5, g: 0.5, b: 0.5, a: 1.0 },
          secondary: { r: 0.5, g: 0.5, b: 0.5, a: 1.0 }
        };

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
      this._applyTextureDerivedPaletteToGridCells(primary, secondary);
      this._syncPrimaryTextureToAllForegrounds();
      return true;
    }

    getPrimaryTexture() {
      return this.primaryTexture;
    }

    /**
     * @returns {{ primary: object, secondary: object } | null} Grid spectrum colours in 0–1 range, if gridCells exists.
     */
    getGridCellsPalette() {
      const grid = this.backgrounds.get("gridCells");
      if (!grid || grid.primary === undefined || grid.secondary === undefined) return null;
      return {
        primary: { ...grid.primary },
        secondary: { ...grid.secondary }
      };
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
      if (!partial || !this.foreground || typeof this.foreground.setSettings !== "function") return;
      this.foreground.setSettings(partial);
    }

    setSustain(bassSustain, trebleSustain) {
      this.bassSustain = Math.max(0, Math.min(1, Number(bassSustain) || 0));
      this.trebleSustain = Math.max(0, Math.min(1, Number(trebleSustain) || 0));
      for (const fg of this.foregrounds.values()) {
        if (typeof fg.setSustain === "function") {
          fg.setSustain(this.bassSustain, this.trebleSustain);
        }
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
      const bc = this.backgroundClearRgb;
      const clearColor = { r: bc.r, g: bc.g, b: bc.b, a: 1.0 };
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
