(() => {
  /**
   * Frequency tree foreground (WebGPU).
   *
   * Debugging:
   * - `globalThis.__FREQ_TREE_DBG = true` — logs vertex/triangle counts on each rebuild.
   * - Toggle **foreground effect** so `init()` → `_rebuildGeometry()` runs; pick **Frequency tree**.
   * - Bump **world scale** in the drawer if geometry is clipped or too thin.
   * - DevTools: **Console** errors; **Issues** panel for shader/pipeline validity.
   */
  function cloneDefaultSceneLights() {
    const D = typeof window !== "undefined" && window.SceneLightingDefaults;
    const ld = D && D.lightDir ? D.lightDir : [0.46, 0.64, 0.46];
    return {
      lightDir: [ld[0], ld[1], ld[2]],
      ambient: D ? D.ambient : 0.24,
      diffuse: D ? D.diffuse : 0.76
    };
  }

  /** Finest FFT band count; pairwise reduction sums to 511 more samples → 1023 total. */
  const LEAF_BINS = 512;
  const PYRAMID_TOTAL = LEAF_BINS * 2 - 1;
  /** depth 0 = leaves (512 nodes), depth 9 = root (stem). */
  const ROOT_DEPTH = 9;

  /** Pentagonal prism — low-poly branch cross-section. */
  const CYL_SIDES = 5;
  /** Two triangles per side, 3 verts per triangle. */
  const FLOATS_PER_VERTEX = 10;
  const TRIS_PER_SEGMENT = CYL_SIDES * 2;
  const VERTS_PER_SEGMENT = TRIS_PER_SEGMENT * 3;
  const STRIDE_BYTES = FLOATS_PER_VERTEX * 4;
  const LINE_SEGMENTS = PYRAMID_TOTAL;

  /** Latitude rings for bauble sphere (not counting the two pole caps). */
  const BAUBLE_LATS = 3;
  /**
   * Verts per bauble: 2 pole caps (CYL_SIDES tris each) + (BAUBLE_LATS-1) quad bands.
   *   = 2 * CYL_SIDES * 3  +  (BAUBLE_LATS - 1) * CYL_SIDES * 6
   */
  const VERTS_PER_BAUBLE = CYL_SIDES * 6 + (BAUBLE_LATS - 1) * CYL_SIDES * 6;

  // Baubles only on the LEAF_BINS (512) leaf nodes, branches on all LINE_SEGMENTS.
  const MAX_VERTICES = LINE_SEGMENTS * VERTS_PER_SEGMENT + LEAF_BINS * VERTS_PER_BAUBLE;
  const MAX_VERTEX_BYTES = MAX_VERTICES * STRIDE_BYTES;
  /** Scratch float offset from `_walk`; byte size = offset × 4, vertex count = offset / 10. */

  /** @type {readonly number[]} Index of first bin at each depth (fine → coarse). */
  const LEVEL_OFFSET = Object.freeze([
    0, 512, 768, 896, 960, 992, 1008, 1016, 1020, 1022
  ]);

  const GOLDEN = 2.3999632297286535;
  const TAU = Math.PI * 2;

  const SHADER_CODE = /* wgsl */ `
    struct Uniforms {
      viewProj: mat4x4<f32>,
      lightDir: vec4<f32>,
      ambient: f32,
      diffuse: f32,
    };

    struct VIn {
      @location(0) position: vec3<f32>,
      @location(1) normal: vec3<f32>,
      @location(2) color: vec4<f32>,
    };

    struct VOut {
      @builtin(position) position: vec4<f32>,
      @location(0) @interpolate(perspective, center) normal: vec3<f32>,
      @location(1) @interpolate(perspective, center) color: vec4<f32>,
    };

    @group(0) @binding(0) var<uniform> uni: Uniforms;

    @vertex
    fn vs_main(input: VIn) -> VOut {
      var out: VOut;
      out.position = uni.viewProj * vec4<f32>(input.position, 1.0);
      out.normal = input.normal;
      out.color = input.color;
      return out;
    }

    @fragment
    fn fs_main(
      @location(0) @interpolate(perspective, center) normal: vec3<f32>,
      @location(1) @interpolate(perspective, center) color: vec4<f32>
    ) -> @location(0) vec4<f32> {
      // Zero normal = unlit (baubles); branches use face normals for Lambert shading.
      if (dot(normal, normal) < 1e-6) {
        return color;
      }
      let l = normalize(uni.lightDir.xyz);
      let n = normalize(normal);
      let diff = max(dot(n, l), 0.0);
      let lit = uni.ambient + diff * uni.diffuse;
      return vec4<f32>(color.rgb * lit, color.a);
    }
  `;

  function normalize3(x, y, z) {
    const len = Math.hypot(x, y, z) || 1;
    return [x / len, y / len, z / len];
  }

  /** @param {number[]} dir — segment direction (any length except ~0); output basis is perpendicular. */
  function orthonormalBasisFromDir(dir) {
    let dx = dir[0];
    let dy = dir[1];
    let dz = dir[2];
    const dl = Math.hypot(dx, dy, dz);
    if (dl < 1e-10) {
      dx = 0;
      dy = 1;
      dz = 0;
    } else {
      dx /= dl;
      dy /= dl;
      dz /= dl;
    }
    const ax = Math.abs(dy) < 0.92 ? [0, 1, 0] : [1, 0, 0];
    let cx = ax[1] * dz - ax[2] * dy;
    let cy = ax[2] * dx - ax[0] * dz;
    let cz = ax[0] * dy - ax[1] * dx;
    let cl = Math.hypot(cx, cy, cz);
    if (cl < 1e-10) {
      cx = 1;
      cy = 0;
      cz = 0;
      cl = 1;
    } else {
      cx /= cl;
      cy /= cl;
      cz /= cl;
    }
    const vx = dy * cz - dz * cy;
    const vy = dz * cx - dx * cz;
    const vz = dx * cy - dy * cx;
    const vl = Math.hypot(vx, vy, vz) || 1;
    return [
      [cx, cy, cz],
      [vx / vl, vy / vl, vz / vl]
    ];
  }

  function faceNormal(ax, ay, az, bx, by, bz, cx, cy, cz) {
    const ex = bx - ax;
    const ey = by - ay;
    const ez = bz - az;
    const fx = cx - ax;
    const fy = cy - ay;
    const fz = cz - az;
    return normalize3(
      ey * fz - ez * fy,
      ez * fx - ex * fz,
      ex * fy - ey * fx
    );
  }

  /**
   * Build two symmetric child directions from parent `dir`; opening angle =
   * `2 * halfAngleRad` between the two child rays.
   */
  function splitDirections(dir, halfAngleRad, depthTwist, ix) {
    const dn = normalize3(dir[0], dir[1], dir[2]);
    const [uRaw, vRaw] = orthonormalBasisFromDir(dn);
    const twist = GOLDEN * depthTwist + ix * 0.73;
    const ct = Math.cos(twist);
    const st = Math.sin(twist);
    const radial = [
      uRaw[0] * ct + vRaw[0] * st,
      uRaw[1] * ct + vRaw[1] * st,
      uRaw[2] * ct + vRaw[2] * st
    ];
    const co = Math.cos(halfAngleRad);
    const si = Math.sin(halfAngleRad);
    const left = normalize3(
      dn[0] * co + radial[0] * si,
      dn[1] * co + radial[1] * si,
      dn[2] * co + radial[2] * si
    );
    const right = normalize3(
      dn[0] * co - radial[0] * si,
      dn[1] * co - radial[1] * si,
      dn[2] * co - radial[2] * si
    );
    return [...left, ...right];
  }

  class FreqTreeRenderer {
    constructor(device, format) {
      this.device = device;
      this.format = format;
      this.pipeline = null;
      this.uniformBuffer = null;
      this.vertexBuffer = null;
      this.bindGroup = null;
      this.uniformStaging = new Float32Array(64);
      this.uniformData = this.uniformStaging;
      this.vertexScratch = new Float32Array(MAX_VERTICES * FLOATS_PER_VERTEX);
      this.pyramidBuf = new Float32Array(PYRAMID_TOTAL);
      /** Spring position per pyramid bin — what `_walk` reads for branch length. */
      this.springPos = new Float32Array(PYRAMID_TOTAL);
      /** Spring velocity per pyramid bin. */
      this.springVel = new Float32Array(PYRAMID_TOTAL);
      this.avgScratch = new Float32Array(Math.max(LEAF_BINS * 4, 576));
      /** Palette colours supplied by the core app when a texture is loaded. */
      this._palette = { primary: null, secondary: null };
      this.settings = {
        branchScale: 2.75,
        angleBetweenBranchesDeg: 90,
        minBranchLengthLow: 0,
        minBranchLengthHigh: 0.42,
        trunkRadius: 0.11,
        /** Multiplier per depth toward leaves (stem = depth ROOT_DEPTH …); each step × this. */
        radiusTaperPerLevel: 0.78,
        /** Scales all lengths and radii so the tree fills the orbit camera view. */
        worldScale: 3.5,
        /**
         * How much the spring velocity is damped each frame (0 = instant snap, 1 = no decay).
         * Matches the `velocity *= friction_amt` step described by the user.
         */
        friction: 0.82,
        /**
         * How strongly the spring is pulled toward the current frequency value each frame.
         * Lower = slower, smoother; higher = snappier with more overshoot.
         */
        springStrength: 0.14,
        /** Bauble radius as a multiple of the branch tip radius at that depth. */
        baubleRadiusScale: 5.4,
        /**
         * Gamma on bauble mix factor (0→secondary, 1→primary). Values below 1 lift
         * mid/high spring levels toward primary so loud bins read brighter.
         */
        baubleMixGamma: 0.45,
        gamma: 0.65,
        floor: 0.04,
        hueRoot: 0.08,
        hueLeaf: 0.55
      };
      this._sceneLights = cloneDefaultSceneLights();
      this.pipelineLayout = null;
      this.bindGroupLayout = null;
      /** Next free float offset in vertex scratch (`writeBuffer` needs `× 4` bytes). */
      this._lastFloatOffset = 0;
    }

    /** @param {{ lightDir: readonly number[], ambient: number, diffuse: number }} state */
    setSceneLights(state) {
      if (!state || !state.lightDir || state.lightDir.length < 3) return;
      const L = this._sceneLights;
      L.lightDir[0] = state.lightDir[0];
      L.lightDir[1] = state.lightDir[1];
      L.lightDir[2] = state.lightDir[2];
      L.ambient = state.ambient;
      L.diffuse = state.diffuse;
    }

    setSpectrumTexture() {}

    setSettings(partial) {
      if (!partial) return;
      if (typeof partial.branchScale === "number") {
        this.settings.branchScale = Math.max(0.2, Math.min(8.0, partial.branchScale));
      }
      if (typeof partial.angleBetweenBranchesDeg === "number") {
        this.settings.angleBetweenBranchesDeg = Math.max(15, Math.min(170, partial.angleBetweenBranchesDeg));
      }
      if (typeof partial.minBranchLengthLow === "number") {
        this.settings.minBranchLengthLow = Math.max(0, Math.min(2.5, partial.minBranchLengthLow));
      }
      if (typeof partial.minBranchLengthHigh === "number") {
        this.settings.minBranchLengthHigh = Math.max(0, Math.min(3.0, partial.minBranchLengthHigh));
      }
      if (typeof partial.trunkRadius === "number") {
        this.settings.trunkRadius = Math.max(0.01, Math.min(0.45, partial.trunkRadius));
      }
      if (typeof partial.radiusTaperPerLevel === "number") {
        this.settings.radiusTaperPerLevel = Math.max(0.45, Math.min(0.98, partial.radiusTaperPerLevel));
      }
      if (typeof partial.worldScale === "number") {
        this.settings.worldScale = Math.max(0.5, Math.min(16, partial.worldScale));
      }
      if (typeof partial.friction === "number") {
        this.settings.friction = Math.max(0.0, Math.min(0.99, partial.friction));
      }
      if (typeof partial.springStrength === "number") {
        this.settings.springStrength = Math.max(0.01, Math.min(1.0, partial.springStrength));
      }
      if (typeof partial.baubleRadiusScale === "number") {
        this.settings.baubleRadiusScale = Math.max(0.3, Math.min(18.0, partial.baubleRadiusScale));
      }
      if (typeof partial.baubleMixGamma === "number") {
        this.settings.baubleMixGamma = Math.max(0.15, Math.min(2.0, partial.baubleMixGamma));
      }
      if (typeof partial.gamma === "number") {
        this.settings.gamma = Math.max(0.25, Math.min(1.8, partial.gamma));
      }
      if (typeof partial.floor === "number") {
        this.settings.floor = Math.max(0, Math.min(0.45, partial.floor));
      }
      if (typeof partial.hueRoot === "number") {
        this.settings.hueRoot = Math.max(0, Math.min(1, partial.hueRoot));
      }
      if (typeof partial.hueLeaf === "number") {
        this.settings.hueLeaf = Math.max(0, Math.min(1, partial.hueLeaf));
      }
    }

    getSettingsSnapshot() {
      return { ...this.settings };
    }

    getParameterDescriptors() {
      return {
        title: "Frequency tree",
        params: [
          { key: "branchScale", label: "Gain (length ×)", type: "range", min: 0.4, max: 6.0, step: 0.05 },
          {
            key: "angleBetweenBranchesDeg",
            label: "Angle between branches (°)",
            type: "range",
            min: 20,
            max: 160,
            step: 1
          },
          {
            key: "minBranchLengthLow",
            label: "Min length (low freq)",
            type: "range",
            min: 0,
            max: 1.2,
            step: 0.02
          },
          {
            key: "minBranchLengthHigh",
            label: "Min length (high freq)",
            type: "range",
            min: 0,
            max: 1.6,
            step: 0.02
          },
          { key: "trunkRadius", label: "Trunk radius", type: "range", min: 0.02, max: 0.28, step: 0.01 },
          {
            key: "radiusTaperPerLevel",
            label: "Radius taper / depth",
            type: "range",
            min: 0.52,
            max: 0.95,
            step: 0.01
          },
          {
            key: "worldScale",
            label: "World scale",
            type: "range",
            min: 0.5,
            max: 12,
            step: 0.25
          },
          { key: "gamma", label: "Gamma", type: "range", min: 0.3, max: 1.6, step: 0.05 },
          { key: "floor", label: "Floor", type: "range", min: 0, max: 0.25, step: 0.01 },
          { key: "hueRoot", label: "Hue (stem)", type: "range", min: 0, max: 1, step: 0.01 },
          { key: "hueLeaf", label: "Hue (leaves)", type: "range", min: 0, max: 1, step: 0.01 },
          {
            key: "friction",
            label: "Spring friction",
            type: "range",
            min: 0.0,
            max: 0.99,
            step: 0.01
          },
          {
            key: "springStrength",
            label: "Spring strength",
            type: "range",
            min: 0.01,
            max: 1.0,
            step: 0.01
          },
          {
            key: "baubleRadiusScale",
            label: "Bauble size",
            type: "range",
            min: 0.3,
            max: 15.0,
            step: 0.1
          },
          {
            key: "baubleMixGamma",
            label: "Bauble mix gamma",
            type: "range",
            min: 0.15,
            max: 2.0,
            step: 0.05
          }
        ]
      };
    }

    clearHistory() {
      this.pyramidBuf.fill(0);
      this.springPos.fill(0);
      this.springVel.fill(0);
    }

    /**
     * Called by Visualizer3D whenever the texture-derived palette changes.
     * `primary` and `secondary` are `{r, g, b}` objects in 0–1 range.
     */
    setPalette(primary, secondary) {
      this._palette.primary = primary ? { r: primary.r, g: primary.g, b: primary.b } : null;
      this._palette.secondary = secondary ? { r: secondary.r, g: secondary.g, b: secondary.b } : null;
    }

    _resampleAveragedTo512(left, rightOrNull) {
      const nIn = left.length;
      const out = this.avgScratch;
      if (!rightOrNull || rightOrNull === left) {
        for (let i = 0; i < LEAF_BINS; i++) {
          const x = ((i + 0.5) / LEAF_BINS) * nIn - 0.5;
          const xf = Math.max(0, Math.min(nIn - 1, x));
          const i0 = Math.floor(xf);
          const i1 = Math.min(nIn - 1, i0 + 1);
          const f = xf - i0;
          out[i] = left[i0] * (1 - f) + left[i1] * f;
        }
      } else {
        for (let i = 0; i < LEAF_BINS; i++) {
          const x = ((i + 0.5) / LEAF_BINS) * nIn - 0.5;
          const xf = Math.max(0, Math.min(nIn - 1, x));
          const i0 = Math.floor(xf);
          const i1 = Math.min(nIn - 1, i0 + 1);
          const f = xf - i0;
          const l = left[i0] * (1 - f) + left[i1] * f;
          const r = rightOrNull[i0] * (1 - f) + rightOrNull[i1] * f;
          out[i] = (l + r) * 0.5;
        }
      }
      return out.subarray(0, LEAF_BINS);
    }

    _buildPyramid(leaf512) {
      const buf = this.pyramidBuf;
      for (let i = 0; i < LEAF_BINS; i++) buf[i] = leaf512[i];

      let readStart = 0;
      let chunk = LEAF_BINS;
      let writeStart = LEAF_BINS;

      while (chunk > 1) {
        const outN = chunk >> 1;
        for (let i = 0; i < outN; i++) {
          buf[writeStart + i] =
            (buf[readStart + 2 * i] + buf[readStart + 2 * i + 1]) * 0.5;
        }
        readStart = writeStart;
        writeStart += outN;
        chunk = outN;
      }
    }

    /**
     * Spring simulation: for each pyramid bin, the raw frequency value acts as a
     * target that velocity is attracted toward (spring force), then velocity is damped
     * by friction and integrated into position.
     *
     *   velocity += (frequency_value - position) * springStrength   ← spring toward target
     *   velocity *= friction_amt                                      ← damping
     *   position += velocity                                          ← integrate
     *
     * The resulting `springPos` array is what `_walk` uses for branch lengths,
     * giving a smooth, averaged response with springy overshoot.
     */
    _updateSprings() {
      const { friction, springStrength } = this.settings;
      const pos = this.springPos;
      const vel = this.springVel;
      const raw = this.pyramidBuf;
      for (let i = 0; i < PYRAMID_TOTAL; i++) {
        vel[i] += (raw[i] - pos[i]) * springStrength;
        vel[i] *= friction;
        pos[i] += vel[i];
        if (pos[i] < 0) pos[i] = 0;
      }
    }

    colorForDepth(depth, peak01, h0, h1) {
      const hue = h1 + (h0 - h1) * (depth / ROOT_DEPTH);
      const s = 0.55 + peak01 * 0.42;
      const v = 0.35 + peak01 * 0.6;
      const c = v * s;
      const x = hue * 6;
      const X = Math.floor(x);
      const frac = x - X;
      const m = v - c;
      let r = 0;
      let g = 0;
      let b = 0;
      switch (X % 6) {
        case 0:
          r = v;
          g = m + c * frac;
          b = m;
          break;
        case 1:
          r = m + c * (1 - frac);
          g = v;
          b = m;
          break;
        case 2:
          r = m;
          g = v;
          b = m + c * frac;
          break;
        case 3:
          r = m;
          g = m + c * (1 - frac);
          b = v;
          break;
        case 4:
          r = m + c * frac;
          g = m;
          b = v;
          break;
        default:
          r = v;
          g = m;
          b = m + c * (1 - frac);
          break;
      }
      return [r, g, b];
    }

    _applyGain(raw) {
      const { gamma, floor } = this.settings;
      const denom = Math.max(1e-6, 1 - floor);
      let v = (Math.max(0, raw) - floor) / denom;
      if (v < 0) v = 0;
      v = Math.pow(v, gamma);
      return Math.min(1, Math.max(0, v));
    }

    /** World radius at tree depth (`depth` ROOT_DEPTH = stem … 0 = twigs). */
    _radiusAtDepth(depth) {
      const { trunkRadius: R, radiusTaperPerLevel: taper } = this.settings;
      const steps = ROOT_DEPTH - depth;
      const r = R * taper ** Math.max(0, steps);
      return Math.max(0.002, r);
    }

    ringPoint(ax, ay, az, ux, uy, uz, vx, vy, vz, theta, radius) {
      const ct = Math.cos(theta);
      const st = Math.sin(theta);
      return [
        ax + radius * (ux * ct + vx * st),
        ay + radius * (uy * ct + vy * st),
        az + radius * (uz * ct + vz * st)
      ];
    }

    writeVertex(vd, o, px, py, pz, nx, ny, nz, cr, cg, cb, ca = 1) {
      vd[o] = px;
      vd[o + 1] = py;
      vd[o + 2] = pz;
      vd[o + 3] = nx;
      vd[o + 4] = ny;
      vd[o + 5] = nz;
      vd[o + 6] = cr;
      vd[o + 7] = cg;
      vd[o + 8] = cb;
      vd[o + 9] = ca;
      return o + FLOATS_PER_VERTEX;
    }

    /**
     * Low-poly truncated cone along segment; `r0` at anchor, `r1` at tip.
     * @returns {number} next float offset
     */
    _appendBranchFrustum(ax, ay, az, bx, by, bz, r0, r1, cr, cg, cb, vd, o0) {
      const dx = bx - ax;
      const dy = by - ay;
      const dz = bz - az;
      const slen = Math.hypot(dx, dy, dz);
      if (slen < 1e-8) return o0;

      const basis = orthonormalBasisFromDir([dx, dy, dz]);
      const u = basis[0];
      const v = basis[1];
      const [ux, uy, uz] = u;
      const [vx, vy, vz] = v;

      let o = o0;
      const M = CYL_SIDES;

      for (let i = 0; i < M; i++) {
        const t0 = (i / M) * TAU;
        const t1 = ((i + 1) / M) * TAU;
        const p0 = this.ringPoint(ax, ay, az, ux, uy, uz, vx, vy, vz, t0, r0);
        const p1 = this.ringPoint(ax, ay, az, ux, uy, uz, vx, vy, vz, t1, r0);
        const p2 = this.ringPoint(bx, by, bz, ux, uy, uz, vx, vy, vz, t0, r1);
        const p3 = this.ringPoint(bx, by, bz, ux, uy, uz, vx, vy, vz, t1, r1);

        const n0 = faceNormal(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);
        o = this.writeVertex(vd, o, p0[0], p0[1], p0[2], n0[0], n0[1], n0[2], cr, cg, cb);
        o = this.writeVertex(vd, o, p1[0], p1[1], p1[2], n0[0], n0[1], n0[2], cr, cg, cb);
        o = this.writeVertex(vd, o, p2[0], p2[1], p2[2], n0[0], n0[1], n0[2], cr, cg, cb);

        const n1 = faceNormal(p1[0], p1[1], p1[2], p3[0], p3[1], p3[2], p2[0], p2[1], p2[2]);
        o = this.writeVertex(vd, o, p1[0], p1[1], p1[2], n1[0], n1[1], n1[2], cr, cg, cb);
        o = this.writeVertex(vd, o, p3[0], p3[1], p3[2], n1[0], n1[1], n1[2], cr, cg, cb);
        o = this.writeVertex(vd, o, p2[0], p2[1], p2[2], n1[0], n1[1], n1[2], cr, cg, cb);
      }
      return o;
    }

    _midFreqNorm(depth, ix) {
      const leafSpan = 1 << depth;
      const leafLo = ix * leafSpan;
      const leafHi = leafLo + leafSpan - 1;
      const mid = (leafLo + leafHi) * 0.5;
      return mid / Math.max(1, LEAF_BINS - 1);
    }

    _minLengthForSubtree(depth, ix) {
      const f = this._midFreqNorm(depth, ix);
      const { minBranchLengthLow: lo, minBranchLengthHigh: hi } = this.settings;
      const t = Math.max(0, Math.min(1, f));
      return lo + t * Math.max(0, hi - lo);
    }

    /**
     * Bauble colour: secondary at level 0, primary at level 1 (app texture palette).
     * Opacity 30% at low volume, 100% at max. `level01` is current-frame frequency 0–1.
     */
    _baubleColor(level01) {
      const D = typeof window !== "undefined" && window.GridCellsBackground;
      const prim = this._palette.primary
        ?? (D ? D.DEFAULT_PRIMARY : { r: 0.961, g: 0.953, b: 1.0 });
      const sec = this._palette.secondary
        ?? (D ? D.DEFAULT_SECONDARY : { r: 0.78, g: 0.639, b: 0.91 });

      const level = Math.max(0, Math.min(1, level01));
      let t = Math.pow(level, this.settings.baubleMixGamma);
      const opacity = 0.3 + level * 0.7;

      return [
        sec.r + (prim.r - sec.r) * t,
        sec.g + (prim.g - sec.g) * t,
        sec.b + (prim.b - sec.b) * t,
        opacity
      ];
    }

    /**
     * Low-poly UV sphere centred at (cx,cy,cz) with radius r.
     * Vertices use a zero normal so the fragment shader outputs fixed colour (no lighting).
     */
    _appendBauble(cx, cy, cz, r, cr, cg, cb, ca, vd, o0) {
      const LATS = BAUBLE_LATS;
      const LONS = CYL_SIDES;
      let o = o0;

      const vert = (lat, lon) => {
        if (lat === 0) return [cx, cy + r, cz];
        if (lat === LATS + 1) return [cx, cy - r, cz];
        const phi = (lat / (LATS + 1)) * Math.PI;
        const theta = (lon / LONS) * TAU;
        const sp = Math.sin(phi), cp = Math.cos(phi);
        const ct = Math.cos(theta), st = Math.sin(theta);
        const nx = sp * ct, ny = cp, nz = sp * st;
        return [cx + r * nx, cy + r * ny, cz + r * nz];
      };

      const wv = (p) => {
        o = this.writeVertex(vd, o, p[0], p[1], p[2], 0, 0, 0, cr, cg, cb, ca);
      };

      // Top cap: north pole → first latitude ring (CCW from above = outward normals)
      for (let lon = 0; lon < LONS; lon++) {
        wv(vert(0, 0));
        wv(vert(1, lon));
        wv(vert(1, (lon + 1) % LONS));
      }

      // Middle bands
      for (let lat = 1; lat < LATS; lat++) {
        for (let lon = 0; lon < LONS; lon++) {
          const lo1 = (lon + 1) % LONS;
          wv(vert(lat,     lon));
          wv(vert(lat,     lo1));
          wv(vert(lat + 1, lon));

          wv(vert(lat,     lo1));
          wv(vert(lat + 1, lo1));
          wv(vert(lat + 1, lon));
        }
      }

      // Bottom cap: last latitude ring → south pole
      for (let lon = 0; lon < LONS; lon++) {
        wv(vert(LATS + 1, 0));
        wv(vert(LATS, (lon + 1) % LONS));
        wv(vert(LATS, lon));
      }

      return o;
    }

    _walk(depth, ix, anchor, dir, vd, floatOffset) {
      const S = this.settings.worldScale;
      const g = LEVEL_OFFSET[depth] + ix;
      const raw = this.springPos[g];
      const pk = this._applyGain(raw);
      const ampLen = pk * this.settings.branchScale * S;
      const minLen = this._minLengthForSubtree(depth, ix) * S;
      const segLen = Math.max(ampLen, minLen);
      const tip = [
        anchor[0] + dir[0] * segLen,
        anchor[1] + dir[1] * segLen,
        anchor[2] + dir[2] * segLen
      ];

      const { hueRoot: h0, hueLeaf: h1, baubleRadiusScale } = this.settings;
      const rgb = this.colorForDepth(depth, pk, h0, h1);

      const rBase = this._radiusAtDepth(depth) * S;
      const rTip = depth > 0 ? this._radiusAtDepth(depth - 1) * S : rBase * 0.88;

      floatOffset = this._appendBranchFrustum(
        anchor[0], anchor[1], anchor[2],
        tip[0], tip[1], tip[2],
        rBase, rTip,
        rgb[0], rgb[1], rgb[2],
        vd,
        floatOffset
      );

      // Baubles only on leaf nodes (depth 0 = finest frequency bins)
      if (depth <= 0) {
        const freqLevel = Math.min(1, Math.max(0, this.pyramidBuf[g]));
        const baubleRgba = this._baubleColor(freqLevel);
        const baubleR = rTip * baubleRadiusScale;
        floatOffset = this._appendBauble(
          tip[0], tip[1], tip[2],
          baubleR,
          baubleRgba[0], baubleRgba[1], baubleRgba[2], baubleRgba[3],
          vd, floatOffset
        );
        return floatOffset;
      }

      const apertureRad = (this.settings.angleBetweenBranchesDeg * Math.PI) / 180;
      const halfRad = apertureRad * 0.5;
      const sd = splitDirections(dir, halfRad, ROOT_DEPTH - depth, ix);
      const left = [sd[0], sd[1], sd[2]];
      const right = [sd[3], sd[4], sd[5]];

      floatOffset = this._walk(depth - 1, ix * 2, tip, left, vd, floatOffset);
      floatOffset = this._walk(depth - 1, ix * 2 + 1, tip, right, vd, floatOffset);
      return floatOffset;
    }

    setAudioFrame(frame) {
      if (!frame?.spectrumData) return;
      const left = frame.spectrumData[0];
      const right = frame.spectrumData[1];
      if (!left?.length) return;
      const mono = this._resampleAveragedTo512(left, right?.length ? right : null);
      this._buildPyramid(mono);
      this._updateSprings();
      this._rebuildGeometry();
    }

    pushSpectrum(_sourceSpectrum) {}

    _rebuildGeometry() {
      const vd = this.vertexScratch;
      const base = [0, 0, 0];
      const rootDir = [0, 1, 0];
      const floatOff = this._walk(ROOT_DEPTH, 0, base, rootDir, vd, 0);
      this._lastFloatOffset = floatOff;
      const uploaded = this.vertexScratch.subarray(0, floatOff);
      this.device.queue.writeBuffer(this.vertexBuffer, 0, uploaded);

      if (typeof window !== "undefined" && window.__FREQ_TREE_DBG) {
        const verts = floatOff / FLOATS_PER_VERTEX;
        console.warn("[FreqTreeRenderer] rebuild", {
          floats: floatOff,
          bytes: uploaded.byteLength,
          triangles: verts / 3,
          segments: verts / VERTS_PER_SEGMENT
        });
      }
    }

    init() {
      this.vertexBuffer = this.device.createBuffer({
        label: "freq-tree-vertices",
        size: MAX_VERTEX_BYTES,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
      });

      this.uniformBuffer = this.device.createBuffer({
        size: 256,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });

      this.bindGroupLayout = this.device.createBindGroupLayout({
        entries: [{
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" }
        }]
      });

      this.pipelineLayout = this.device.createPipelineLayout({
        bindGroupLayouts: [this.bindGroupLayout]
      });

      const module = this.device.createShaderModule({ code: SHADER_CODE });
      this.pipeline = this.device.createRenderPipeline({
        label: "freq-tree-mesh",
        layout: this.pipelineLayout,
        vertex: {
          module,
          entryPoint: "vs_main",
          buffers: [{
            arrayStride: STRIDE_BYTES,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 12, format: "float32x3" },
              { shaderLocation: 2, offset: 24, format: "float32x4" }
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
        primitive: {
          topology: "triangle-list",
          cullMode: "none"
        },
        depthStencil: {
          format: "depth24plus",
          depthWriteEnabled: true,
          depthCompare: "less"
        }
      });

      this.bindGroup = this.device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [{
          binding: 0,
          resource: { buffer: this.uniformBuffer }
        }]
      });

      this._rebuildGeometry();
    }

    draw(passEncoder, viewProj) {
      if (!this.pipeline || !this.vertexBuffer || !this.bindGroup) return;
      if (this._lastFloatOffset <= 0) this._rebuildGeometry();

      const L = this._sceneLights;
      this.uniformData.set(viewProj, 0);
      this.uniformData[16] = L.lightDir[0];
      this.uniformData[17] = L.lightDir[1];
      this.uniformData[18] = L.lightDir[2];
      this.uniformData[19] = 0;
      this.uniformData[20] = L.ambient;
      this.uniformData[21] = L.diffuse;
      this.uniformData[22] = 0;
      this.uniformData[23] = 0;

      this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);

      passEncoder.setPipeline(this.pipeline);
      passEncoder.setVertexBuffer(0, this.vertexBuffer);
      passEncoder.setBindGroup(0, this.bindGroup);

      /** Float offset / 9 (always multiple of FLOATS_PER_VERTEX). */
      const verts = this._lastFloatOffset > 0 ? this._lastFloatOffset / FLOATS_PER_VERTEX : 0;
      if (verts > 0) {
        passEncoder.draw(verts);
      }
    }

    setSustain() {}
  }

  window.FreqTreeRenderer = FreqTreeRenderer;
})();
