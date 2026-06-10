(() => {
  const DEFAULT_FADE_COLOR = { r: 0.965, g: 0.96, b: 0.985 };

  const READBACK_BLIT_SHADER = /* wgsl */`
    struct VSOut {
      @builtin(position) position: vec4<f32>,
      @location(0) uv: vec2<f32>,
    }

    @group(0) @binding(0) var samp: sampler;
    @group(0) @binding(1) var srcTex: texture_2d<f32>;

    @vertex
    fn vs_blit(@builtin(vertex_index) vid: u32) -> VSOut {
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
    fn fs_blit(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
      let c = textureSample(srcTex, samp, uv);
      return vec4<f32>(c.rgb, 1.0);
    }
  `;

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
      this.feedbackEffect = "zoom";
      this.beatEffect = "rgbChannelSplit";
      this.fgInFeedback = false;
      this.fadeColor = { ...DEFAULT_FADE_COLOR };
      this.zoomPost = null;
      this.stainedGlassPost = null;
      this.stainedGlassCellPost = null;
      this.interlacedSplitPost = null;
      this.rgbChannelSplitPost = null;
      this.lastRenderMs = 0;

      this.primaryTexture = null;
      this.primaryTextureUrl = null;
      /** @type {Map<string, { texture: GPUTexture, primary: object, secondary: object }>} */
      this.textureCache = new Map();

      this.running = false;
      this.paused = false;
      this.pauseStartedAt = 0;
      this.startTime = 0;
      this.camera = new OrbitCamera();
      this.bassSustain = 0;
      this.trebleSustain = 0;
      this.trebleLevel = 0;
      /** @type {{ resolve: (blob: Blob | null) => void, quality: number } | null} */
      this._pendingJpegCapture = null;
      this._readbackTexture = null;
      this._readbackBuffer = null;
      this._readbackBytesPerRow = 0;
      this._readbackWidth = 0;
      this._readbackHeight = 0;
      this._readbackSampler = null;
      this._readbackBlitBGLayout = null;
      this._readbackBlitPipeline = null;
      this._readbackBlitBindGroup = null;
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

      const doubleWf = this.backgrounds.get("doubleWaveform");
      if (doubleWf && typeof doubleWf.setLineColor === "function") {
        doubleWf.setLineColor(prim.r, prim.g, prim.b, 0.95);
      }

      const sideWf = this.backgrounds.get("sideWaveform");
      if (sideWf && typeof sideWf.setLineColor === "function") {
        sideWf.setLineColor(prim.r, prim.g, prim.b, 0.95);
      }

      const noteRings = this.backgrounds.get("noteRings");
      if (noteRings && typeof noteRings.setHighlightColor === "function") {
        noteRings.setHighlightColor(prim.r, prim.g, prim.b, 1.0);
      }

      const noteMapCircles = this.backgrounds.get("noteMapCircles");
      if (noteMapCircles && typeof noteMapCircles.setHighlightColor === "function") {
        noteMapCircles.setHighlightColor(prim.r, prim.g, prim.b, 1.0);
      }

      if (this.zoomPost && typeof this.zoomPost.setSceneBackgroundColor === "function") {
        this.zoomPost.setSceneBackgroundColor(sec.r, sec.g, sec.b);
      }
      if (this.stainedGlassPost && typeof this.stainedGlassPost.setSceneBackgroundColor === "function") {
        this.stainedGlassPost.setSceneBackgroundColor(sec.r, sec.g, sec.b);
      }
      if (this.stainedGlassCellPost && typeof this.stainedGlassCellPost.setSceneBackgroundColor === "function") {
        this.stainedGlassCellPost.setSceneBackgroundColor(sec.r, sec.g, sec.b);
      }
      for (const fg of this.foregrounds.values()) {
        if (typeof fg.setPalette === "function") {
          fg.setPalette(prim, sec);
        }
      }
      this._syncZoomFadeColorWithBackground();
    }

    /**
     * When feedback zoom has "fade follows background", keep fade RGB in sync with scene clear colour.
     */
    _syncZoomFadeColorWithBackground() {
      const bc = this.backgroundClearRgb;
      if (this.feedbackEffect === "zoom" && this.zoomPost && this.zoomPost.fadeColorFollowsBackground) {
        this.zoomPost.setFadeColor(bc.r, bc.g, bc.b);
        this.fadeColor = { r: bc.r, g: bc.g, b: bc.b };
      }
      if (
        this.feedbackEffect === "stainedGlass"
        && this.stainedGlassPost
        && this.stainedGlassPost.fadeColorFollowsBackground
      ) {
        this.stainedGlassPost.setFadeColor(bc.r, bc.g, bc.b);
        this.fadeColor = { r: bc.r, g: bc.g, b: bc.b };
      }
      if (
        this.feedbackEffect === "stainedGlassCells"
        && this.stainedGlassCellPost
        && this.stainedGlassCellPost.fadeColorFollowsBackground
      ) {
        this.stainedGlassCellPost.setFadeColor(bc.r, bc.g, bc.b);
        this.fadeColor = { r: bc.r, g: bc.g, b: bc.b };
      }
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
      if (typeof DoubleWaveformBackground === "function") {
        const doubleWaveform = new DoubleWaveformBackground({ canvas: this.canvas });
        doubleWaveform.init(this.device, this.format);
        this.backgrounds.set("doubleWaveform", doubleWaveform);
      }
      if (typeof SideWaveformBackground === "function") {
        const sideWaveform = new SideWaveformBackground({ canvas: this.canvas });
        sideWaveform.init(this.device, this.format);
        this.backgrounds.set("sideWaveform", sideWaveform);
      }
      if (typeof GridCellsBackground === "function") {
        const gridCells = new GridCellsBackground({ canvas: this.canvas });
        gridCells.init(this.device, this.format);
        this.backgrounds.set("gridCells", gridCells);
      }
      if (typeof NoteRingsBackground === "function") {
        const noteRings = new NoteRingsBackground({ canvas: this.canvas });
        noteRings.init(this.device, this.format);
        this.backgrounds.set("noteRings", noteRings);
      }
      if (typeof NoteMapCirclesBackground === "function") {
        const noteMapCircles = new NoteMapCirclesBackground({ canvas: this.canvas });
        noteMapCircles.init(this.device, this.format);
        this.backgrounds.set("noteMapCircles", noteMapCircles);
      }

      if (typeof FullscreenZoomEffect === "function") {
        this.zoomPost = new FullscreenZoomEffect();
        this.zoomPost.setFadeColor(this.fadeColor.r, this.fadeColor.g, this.fadeColor.b);
        this.zoomPost.init(this.device, this.format, this.canvas);
      }
      if (typeof StainedGlassRotationEffect === "function") {
        this.stainedGlassPost = new StainedGlassRotationEffect();
        this.stainedGlassPost.setFadeColor(this.fadeColor.r, this.fadeColor.g, this.fadeColor.b);
        this.stainedGlassPost.init(this.device, this.format, this.canvas);
      }
      if (typeof StainedGlassCellEffect === "function") {
        this.stainedGlassCellPost = new StainedGlassCellEffect();
        this.stainedGlassCellPost.setFadeColor(this.fadeColor.r, this.fadeColor.g, this.fadeColor.b);
        this.stainedGlassCellPost.init(this.device, this.format, this.canvas);
      }
      if (typeof InterlacedSplitEffect === "function") {
        this.interlacedSplitPost = new InterlacedSplitEffect();
        this.interlacedSplitPost.init(this.device, this.format, this.canvas);
      }
      if (typeof RgbChannelSplitEffect === "function") {
        this.rgbChannelSplitPost = new RgbChannelSplitEffect();
        this.rgbChannelSplitPost.init(this.device, this.format, this.canvas);
      }

      const wireframe = new GridWireframeRenderer(this.device, this.format);
      wireframe.init();
      this.foregrounds.set("wireframeGrid", wireframe);
      if (typeof DRingsRenderer === "function") {
        const dRings = new DRingsRenderer(this.device, this.format);
        dRings.init();
        this.foregrounds.set("dRings", dRings);
      }
      if (typeof SpikeCylinderRenderer === "function") {
        const spikeCylinder = new SpikeCylinderRenderer(this.device, this.format);
        spikeCylinder.init();
        this.foregrounds.set("spikeCylinder", spikeCylinder);
      }
      if (typeof FreqTreeRenderer === "function") {
        const freqTree = new FreqTreeRenderer(this.device, this.format);
        freqTree.init();
        this.foregrounds.set("freqTree", freqTree);
      }

      this.setBackground("gridCells");
      this.setForeground("wireframeGrid");
      this.setFeedbackEffect("zoom");
      this.setBeatEffect("rgbChannelSplit");
      this.setFgInFeedback(false);

      this._initReadbackBlit();
      this._ensureReadbackResources();

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

    _getBeatPost(effectKey) {
      if (effectKey === "interlacedSplit") return this.interlacedSplitPost;
      if (effectKey === "rgbChannelSplit") return this.rgbChannelSplitPost;
      return null;
    }

    _getFeedbackPost(effectKey) {
      if (effectKey === "zoom" && this.zoomPost) {
        return { post: this.zoomPost, needsElapsed: false };
      }
      if (effectKey === "stainedGlass" && this.stainedGlassPost) {
        return { post: this.stainedGlassPost, needsElapsed: true };
      }
      if (effectKey === "stainedGlassCells" && this.stainedGlassCellPost) {
        return { post: this.stainedGlassCellPost, needsElapsed: true };
      }
      return null;
    }

    _getFeedbackInstance(effectKey) {
      if (effectKey === "zoom") return this.zoomPost;
      if (effectKey === "stainedGlass") return this.stainedGlassPost;
      if (effectKey === "stainedGlassCells") return this.stainedGlassCellPost;
      return null;
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
      if (this.currentBackground && this.currentBackground !== "none") {
        const bgInst = this.backgrounds.get(this.currentBackground);
        if (bgInst) {
          push("background", this.currentBackground, bgInst);
        }
      }
      if (this.currentForeground && this.foreground) {
        push("foreground", this.currentForeground, this.foreground);
      }
      if (this.feedbackEffect === "zoom" && this.zoomPost) {
        push("feedback", "zoom", this.zoomPost);
      }
      if (this.feedbackEffect === "stainedGlass" && this.stainedGlassPost) {
        push("feedback", "stainedGlass", this.stainedGlassPost);
      }
      if (this.feedbackEffect === "stainedGlassCells" && this.stainedGlassCellPost) {
        push("feedback", "stainedGlassCells", this.stainedGlassCellPost);
      }
      if (this.beatEffect !== "none") {
        const beatInst = this._getBeatPost(this.beatEffect);
        if (beatInst) push("beat", this.beatEffect, beatInst);
      }
      return { groups };
    }

    /**
     * Apply settings only to the given active effect instance.
     * @param {"foreground"|"background"|"feedback"|"beat"} scope
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
        instance = this.backgrounds.get(effectKey) ?? this.background;
      } else if (scope === "feedback") {
        if (this.feedbackEffect !== effectKey) return false;
        instance = this._getFeedbackInstance(effectKey);
        if (!instance) return false;
      } else if (scope === "beat") {
        if (this.beatEffect !== effectKey) return false;
        instance = this._getBeatPost(effectKey);
        if (!instance) return false;
      }
      if (!instance || typeof instance.setSettings !== "function") return false;
      instance.setSettings(partial);
      if (scope === "feedback" && (effectKey === "zoom" || effectKey === "stainedGlass" || effectKey === "stainedGlassCells")) {
        this._syncZoomFadeColorWithBackground();
        const fbInst = this._getFeedbackInstance(effectKey);
        if (fbInst && fbInst.fadeColor) {
          this.fadeColor = {
            r: fbInst.fadeColor.r,
            g: fbInst.fadeColor.g,
            b: fbInst.fadeColor.b
          };
        }
      }
      return true;
    }

    /**
     * @param {"foreground"|"background"|"feedback"|"beat"} scope
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
        instance = this.backgrounds.get(effectKey) ?? this.background;
      } else if (scope === "feedback") {
        if (this.feedbackEffect !== effectKey) return null;
        instance = this._getFeedbackInstance(effectKey);
        if (!instance) return null;
      } else if (scope === "beat") {
        if (this.beatEffect !== effectKey) return null;
        instance = this._getBeatPost(effectKey);
      }
      if (!instance || typeof instance.getSettingsSnapshot !== "function") return null;
      return instance.getSettingsSnapshot();
    }

    /**
     * Snapshots from every initialized effect instance (active or not).
     * @returns {Record<string, object>}
     */
    exportAllEffectSnapshots() {
      /** @type {Record<string, object>} */
      const out = {};
      const add = (scope, effectKey, instance) => {
        if (!instance || typeof instance.getSettingsSnapshot !== "function") return;
        const snap = instance.getSettingsSnapshot();
        if (snap && typeof snap === "object") {
          out[scope + ":" + effectKey] = snap;
        }
      };
      for (const [key, inst] of this.backgrounds) add("background", key, inst);
      for (const [key, inst] of this.foregrounds) add("foreground", key, inst);
      if (this.zoomPost) add("feedback", "zoom", this.zoomPost);
      if (this.stainedGlassPost) add("feedback", "stainedGlass", this.stainedGlassPost);
      if (this.stainedGlassCellPost) add("feedback", "stainedGlassCells", this.stainedGlassCellPost);
      if (this.interlacedSplitPost) add("beat", "interlacedSplit", this.interlacedSplitPost);
      if (this.rgbChannelSplitPost) add("beat", "rgbChannelSplit", this.rgbChannelSplitPost);
      return out;
    }

    /** @returns {{ lightDir: number[], ambient: number, diffuse: number } | null} */
    getSceneLightsSnapshot() {
      if (!this.sceneLights) return null;
      const L = this.sceneLights;
      return {
        lightDir: [L.lightDir[0], L.lightDir[1], L.lightDir[2]],
        ambient: L.ambient,
        diffuse: L.diffuse
      };
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
      if (this.foreground && typeof this.foreground.setAudioFrame === "function" && this.latestAudioFrame) {
        this.foreground.setAudioFrame(this.latestAudioFrame);
      }
      this._notifyParameterDescriptors();
      return true;
    }

    setFeedbackEffect(name) {
      const allowed = new Set(["none", "zoom", "stainedGlass", "stainedGlassCells"]);
      const next = allowed.has(name) ? name : "none";
      if (next !== this.feedbackEffect) {
        if (next === "zoom" && this.zoomPost) this.zoomPost.reset();
        if (next === "stainedGlass" && this.stainedGlassPost) this.stainedGlassPost.reset();
        if (next === "stainedGlassCells" && this.stainedGlassCellPost) this.stainedGlassCellPost.reset();
      }
      this.feedbackEffect = next;
      this._syncZoomFadeColorWithBackground();
      this._notifyParameterDescriptors();
      return true;
    }

    setBeatEffect(name) {
      const allowed = new Set(["none", "interlacedSplit", "rgbChannelSplit"]);
      const next = allowed.has(name) ? name : "none";
      if (next !== this.beatEffect) {
        const prev = this._getBeatPost(this.beatEffect);
        if (prev) prev.reset();
      }
      this.beatEffect = next;
      this._notifyParameterDescriptors();
      return true;
    }

    setFadeColor(r, g, b) {
      this.fadeColor = { r, g, b };
      if (this.zoomPost) {
        this.zoomPost.setFadeColor(r, g, b);
      }
      if (this.stainedGlassPost) {
        this.stainedGlassPost.setFadeColor(r, g, b);
      }
      if (this.stainedGlassCellPost) {
        this.stainedGlassCellPost.setFadeColor(r, g, b);
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

    /**
     * Clears the active primary texture reference without destroying the
     * underlying GPU texture, which is owned by the texture cache.
     */
    _clearPrimaryTextureRef() {
      if (this.primaryTexture) {
        for (const fg of this.foregrounds.values()) {
          if (typeof fg.setSpectrumTexture === "function") {
            fg.setSpectrumTexture(null);
          }
        }
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
     * Fetches, decodes, derives a palette, and uploads a GPU texture for the
     * given source URL. Pure loader: does not mutate the active selection.
     * @param {string} src
     * @returns {Promise<{ texture: GPUTexture, primary: object, secondary: object }>}
     */
    async _loadTextureEntry(src) {
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

      return { texture, primary, secondary };
    }

    /**
     * Pre-fetches, decodes, and uploads every texture so later selections are
     * instant. Runs sequentially to avoid a decode/upload spike; failures for
     * individual URLs are skipped. Already-cached URLs are not re-loaded.
     * @param {string[]} urls
     * @param {(done: number, total: number) => void} [onProgress] Invoked after each URL is processed.
     * @returns {Promise<{ cached: number, failed: number }>}
     */
    async precacheTextures(urls, onProgress) {
      if (!this.device || !Array.isArray(urls)) {
        return { cached: 0, failed: 0 };
      }
      const total = urls.length;
      let cached = 0;
      let failed = 0;
      let done = 0;
      for (const url of urls) {
        const src = String(url || "").trim();
        if (src && !this.textureCache.has(src)) {
          try {
            const entry = await this._loadTextureEntry(src);
            this.textureCache.set(src, entry);
            cached++;
          } catch (_) {
            failed++;
          }
        }
        done++;
        if (typeof onProgress === "function") {
          try { onProgress(done, total); } catch (_) { /* ignore */ }
        }
      }
      return { cached, failed };
    }

    /**
     * Loads an image as the primary GPU texture (for upcoming shader use) and
     * sets spectrum grid primary (mean RGB) and secondary (complementary hue + texture S/L).
     * Pass null to clear. Uses the texture cache when available so repeat
     * selections incur no fetch/decode/upload delay.
     */
    async setPrimaryTextureAsset(url) {
      if (!this.device) return false;

      if (!url || String(url).trim() === "") {
        this._clearPrimaryTextureRef();
        this._resetGridCellsPalette();
        return true;
      }

      const src = String(url).trim();
      let entry = this.textureCache.get(src);
      if (!entry) {
        entry = await this._loadTextureEntry(src);
        this.textureCache.set(src, entry);
      }

      this._clearPrimaryTextureRef();
      this.primaryTexture = entry.texture;
      this.primaryTextureUrl = src;
      this._applyTextureDerivedPaletteToGridCells(entry.primary, entry.secondary);
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
      if (this.stainedGlassPost && typeof this.stainedGlassPost.resize === "function") {
        this.stainedGlassPost.resize();
      }
      if (this.stainedGlassCellPost && typeof this.stainedGlassCellPost.resize === "function") {
        this.stainedGlassCellPost.resize();
      }
      if (this.interlacedSplitPost && typeof this.interlacedSplitPost.resize === "function") {
        this.interlacedSplitPost.resize();
      }
      if (this.rgbChannelSplitPost && typeof this.rgbChannelSplitPost.resize === "function") {
        this.rgbChannelSplitPost.resize();
      }
      this._ensureReadbackResources();
    }

    _initReadbackBlit() {
      if (!this.device) return;

      this._readbackSampler = this.device.createSampler({
        magFilter: "linear",
        minFilter: "linear"
      });

      const module = this.device.createShaderModule({ code: READBACK_BLIT_SHADER });
      this._readbackBlitBGLayout = this.device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } }
        ]
      });

      this._readbackBlitPipeline = this.device.createRenderPipeline({
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this._readbackBlitBGLayout] }),
        vertex: { module, entryPoint: "vs_blit" },
        fragment: {
          module,
          entryPoint: "fs_blit",
          targets: [{ format: this.format }]
        },
        primitive: { topology: "triangle-list" }
      });
    }

    _ensureReadbackResources() {
      if (!this.device || !this.canvas || !this.format) return;

      const w = this.canvas.width || 1;
      const h = this.canvas.height || 1;
      if (this._readbackWidth === w && this._readbackHeight === h && this._readbackTexture) {
        return;
      }

      if (this._readbackTexture) this._readbackTexture.destroy();
      if (this._readbackBuffer) this._readbackBuffer.destroy();

      this._readbackTexture = this.device.createTexture({
        size: [w, h],
        format: this.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT
          | GPUTextureUsage.COPY_SRC
          | GPUTextureUsage.TEXTURE_BINDING
      });

      const bytesPerPixel = 4;
      const unpaddedBytesPerRow = w * bytesPerPixel;
      this._readbackBytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
      this._readbackBuffer = this.device.createBuffer({
        size: this._readbackBytesPerRow * h,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      });

      this._readbackWidth = w;
      this._readbackHeight = h;

      if (this._readbackBlitBGLayout && this._readbackSampler) {
        this._readbackBlitBindGroup = this.device.createBindGroup({
          layout: this._readbackBlitBGLayout,
          entries: [
            { binding: 0, resource: this._readbackSampler },
            { binding: 1, resource: this._readbackTexture.createView() }
          ]
        });
      }
    }

    _blitReadbackToSwapchain(encoder, swapchainView) {
      if (!this._readbackBlitPipeline || !this._readbackBlitBindGroup) return;

      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: swapchainView,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store"
        }]
      });
      pass.setPipeline(this._readbackBlitPipeline);
      pass.setBindGroup(0, this._readbackBlitBindGroup);
      pass.draw(3, 1, 0, 0);
      pass.end();
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

    setSustain(bassSustain, trebleSustain, trebleLevel) {
      this.bassSustain = Math.max(0, Math.min(1, Number(bassSustain) || 0));
      this.trebleSustain = Math.max(0, Math.min(1, Number(trebleSustain) || 0));
      if (typeof trebleLevel === "number") {
        this.trebleLevel = Math.max(0, Math.min(1, trebleLevel));
      }
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
      for (const fg of this.foregrounds.values()) {
        if (typeof fg.setAudioFrame === "function") {
          fg.setAudioFrame(this.latestAudioFrame);
        }
      }
      const beatPost = this._getBeatPost(this.beatEffect);
      if (frame && frame.bassBeat && beatPost) {
        beatPost.trigger();
      }
    }

    start() {
      if (this.running || !this.device) return;
      this.running = true;
      this.paused = false;
      this.pauseStartedAt = 0;
      this.startTime = performance.now();
      this.lastRenderMs = performance.now();
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
      if (this.running) this._loop();
    }

    isPaused() {
      return this.paused;
    }

    /**
     * Capture the displayed WebGPU canvas as JPEG on the next presented frame.
     * @param {number} [quality=0.92] JPEG quality 0–1
     * @returns {Promise<Blob | null>}
     */
    captureDisplayedFrameAsJpegBlob(quality = 0.92) {
      if (!this.device || !this.canvas) {
        return Promise.resolve(null);
      }
      const q = typeof quality === "number" && Number.isFinite(quality)
        ? Math.min(1, Math.max(0.5, quality))
        : 0.92;
      return new Promise((resolve) => {
        this._pendingJpegCapture = { resolve, quality: q };
        if (this.paused && this.running) {
          this._render();
        }
      });
    }

    async _finishJpegCapture(resolve, quality) {
      try {
        if (!this._readbackBuffer) {
          resolve(null);
          return;
        }
        await this.device.queue.onSubmittedWorkDone();
        await this._readbackBuffer.mapAsync(GPUMapMode.READ);
        const blob = await this._readbackBufferToJpegBlob(quality);
        this._readbackBuffer.unmap();
        resolve(blob);
      } catch (err) {
        console.error(err);
        try {
          if (this._readbackBuffer) this._readbackBuffer.unmap();
        } catch {
          /* ignore */
        }
        resolve(null);
      }
    }

    async _readbackBufferToJpegBlob(quality) {
      const w = this.canvas.width;
      const h = this.canvas.height;
      if (w < 1 || h < 1) return null;

      const src = new Uint8Array(this._readbackBuffer.getMappedRange());
      const bytesPerRow = this._readbackBytesPerRow;

      const off = document.createElement("canvas");
      off.width = w;
      off.height = h;
      const ctx = off.getContext("2d");
      if (!ctx) return null;

      const imageData = ctx.createImageData(w, h);
      const dst = imageData.data;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const si = y * bytesPerRow + x * 4;
          const di = (y * w + x) * 4;
          dst[di] = src[si + 2];
          dst[di + 1] = src[si + 1];
          dst[di + 2] = src[si];
          dst[di + 3] = 255;
        }
      }
      ctx.putImageData(imageData, 0, 0);

      return new Promise((res) => {
        off.toBlob((blob) => res(blob), "image/jpeg", quality);
      });
    }

    _loop() {
      if (!this.running || this.paused) return;
      this._render();
      requestAnimationFrame(() => this._loop());
    }

    _render() {
      this.resize();

      const elapsed = (performance.now() - this.startTime) / 1000;
      const aspect = this.canvas.width / Math.max(1, this.canvas.height);
      const viewProj = this.camera.getViewProjection(elapsed, aspect, {
        bassSustain: this.bassSustain,
        trebleLevel: this.trebleLevel
      });

      if (this.background && typeof this.background.setAudioFrame === "function") {
        this.background.setAudioFrame(this.latestAudioFrame);
      }

      const nowMs = performance.now();
      const dt = this.lastRenderMs > 0 ? (nowMs - this.lastRenderMs) / 1000 : 0;
      this.lastRenderMs = nowMs;

      const encoder = this.device.createCommandEncoder();
      const swapchainTexture = this.context.getCurrentTexture();
      const swapchainView = swapchainTexture.createView();
      const depthView = this.depthTexture.createView();
      const bc = this.backgroundClearRgb;
      const clearColor = { r: bc.r, g: bc.g, b: bc.b, a: 1.0 };
      const capturing = !!this._pendingJpegCapture;
      if (capturing) {
        this._ensureReadbackResources();
      }
      const readbackView = capturing && this._readbackTexture
        ? this._readbackTexture.createView()
        : null;
      const canvasTargetView = capturing ? readbackView : swapchainView;
      const beatPost = this._getBeatPost(this.beatEffect);
      const useBeat = !!beatPost;
      const beatResolveView = useBeat ? beatPost.getRenderTargetView() : null;
      const sceneColorView = beatResolveView || canvasTargetView;
      const fb = this._getFeedbackPost(this.feedbackEffect);
      const useFeedback = !!fb;
      const feedbackPost = fb ? fb.post : null;

      if (useFeedback) {
        if (fb.needsElapsed) {
          feedbackPost.composeToFeedback(encoder, elapsed);
        } else {
          feedbackPost.composeToFeedback(encoder);
        }

        const fbWriteView = feedbackPost.getFeedbackWriteView();

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

        feedbackPost.presentToSwapchain(encoder, sceneColorView);

        if (!this.fgInFeedback && this.foreground && typeof this.foreground.draw === "function") {
          const fgPass = encoder.beginRenderPass({
            colorAttachments: [{
              view: sceneColorView,
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

        feedbackPost.flipFeedback();
      } else {
        const pass = encoder.beginRenderPass({
          colorAttachments: [{
            view: sceneColorView,
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

      if (useBeat) {
        beatPost.update(dt);
        beatPost.presentToSwapchain(encoder, canvasTargetView);
      }

      if (capturing && this._readbackTexture && this._readbackBuffer) {
        const w = this.canvas.width;
        const h = this.canvas.height;
        encoder.copyTextureToBuffer(
          { texture: this._readbackTexture },
          { width: w, height: h, depthOrArrayLayers: 1 },
          this._readbackBuffer,
          { bytesPerRow: this._readbackBytesPerRow, rowsPerImage: h }
        );
        this._blitReadbackToSwapchain(encoder, swapchainView);
      }

      this.device.queue.submit([encoder.finish()]);

      const pendingCapture = this._pendingJpegCapture;
      if (pendingCapture) {
        this._pendingJpegCapture = null;
        this._finishJpegCapture(pendingCapture.resolve, pendingCapture.quality);
      }
    }
  }

  Visualizer3D.GRID_SIZE = GridWireframeRenderer.GRID_SIZE;
  Visualizer3D.GRID_DEPTH = GridWireframeRenderer.GRID_DEPTH;
  window.Visualizer3D = Visualizer3D;
})();
