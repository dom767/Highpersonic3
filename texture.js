(() => {
  function rgb01ToHsl(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0;
    let s = 0;
    if (max - min > 1e-10) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max - r < 1e-10) {
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      } else if (max - g < 1e-10) {
        h = ((b - r) / d + 2) / 6;
      } else {
        h = ((r - g) / d + 4) / 6;
      }
    }
    return [h, s, l];
  }

  function hsl01ToRgb(h, s, l) {
    if (s < 1e-10) {
      return [l, l, l];
    }
    const hue2rgb = (p, q, t) => {
      let x = t;
      if (x < 0) x += 1;
      if (x > 1) x -= 1;
      if (x < 1 / 6) return p + (q - p) * 6 * x;
      if (x < 1 / 2) return q;
      if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [
      hue2rgb(p, q, h + 1 / 3),
      hue2rgb(p, q, h),
      hue2rgb(p, q, h - 1 / 3)
    ];
  }

  function median(numbers) {
    if (!numbers.length) return 0.5;
    const sorted = numbers.slice().sort((a, b) => a - b);
    const m = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
  }

  /**
   * Primary: mean sRGB over every pixel. Secondary: complementary hue (HSL h + 0.5) with
   * saturation/lightness from subsampled pixel medians, clamped for grid mix readability.
   * @param {ImageBitmap} bitmap
   * @returns {{ primary: { r:number,g:number,b:number,a:number }, secondary: { r:number,g:number,b:number,a:number } }}
   */
  function derivePaletteFromBitmap(bitmap) {
    const w = bitmap.width;
    const height = bitmap.height;
    const n = w * height;
    const empty = {
      primary: { r: 0, g: 0, b: 0, a: 1.0 },
      secondary: { r: 0.5, g: 0.5, b: 0.5, a: 1.0 }
    };
    if (n < 1) return empty;

    const canvas =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(w, height)
        : Object.assign(document.createElement("canvas"), { width: w, height });
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, w, height);

    const maxStatSamples = 32768;
    const statStride = Math.max(1, Math.floor(n / maxStatSamples));

    let sr = 0;
    let sg = 0;
    let sb = 0;
    const sSamples = [];
    const lSamples = [];

    for (let p = 0; p < n; p++) {
      const i = p * 4;
      sr += data[i];
      sg += data[i + 1];
      sb += data[i + 2];
      if (p % statStride === 0) {
        const r = data[i] / 255;
        const g = data[i + 1] / 255;
        const bCh = data[i + 2] / 255;
        const [, sat, lum] = rgb01ToHsl(r, g, bCh);
        sSamples.push(sat);
        lSamples.push(lum);
      }
    }

    const inv = 1 / n;
    const primary = {
      r: sr * inv / 255,
      g: sg * inv / 255,
      b: sb * inv / 255,
      a: 1.0
    };

    const medS = median(sSamples);
    const medL = median(lSamples);

    const [hp, , lp] = rgb01ToHsl(primary.r, primary.g, primary.b);
    const hSec = hp + 0.5 - Math.floor(hp + 0.5);

    const sBoost = 1.12;
    const sFloor = 0.18;
    const sCeil = 0.92;
    const sSec = Math.min(sCeil, Math.max(sFloor, Math.max(medS * sBoost, sFloor)));

    const lMin = 0.24;
    const lMax = 0.76;
    let lSec = Math.min(lMax, Math.max(lMin, medL));
    const lPull = 0.08;
    lSec = lSec * (1 - lPull) + 0.5 * lPull;

    let sUse = sSec;
    let lUse = lSec;
    let [rr, gg, bb] = hsl01ToRgb(hSec, sUse, lUse);

    const dist = Math.sqrt(
      (rr - primary.r) ** 2 + (gg - primary.g) ** 2 + (bb - primary.b) ** 2
    );
    if (dist < 0.14) {
      sUse = Math.min(sCeil, sUse + 0.2);
      lUse = Math.min(lMax, Math.max(lMin, lUse + (lp < 0.5 ? 0.22 : -0.22)));
      [rr, gg, bb] = hsl01ToRgb(hSec, sUse, lUse);
    }

    const secondary = {
      r: Math.min(1, Math.max(0, rr)),
      g: Math.min(1, Math.max(0, gg)),
      b: Math.min(1, Math.max(0, bb)),
      a: 1.0
    };

    return { primary, secondary };
  }

  window.TexturePalette = {
    deriveFromBitmap: derivePaletteFromBitmap
  };
})();
