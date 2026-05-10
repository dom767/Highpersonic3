---
name: highpersonic3-background-effects
description: >-
  Adds or modifies WebGPU background effects (canvas backdrop behind the 3D
  scene) for Highpersonic3. Use when implementing or editing files under
  background/, circular wave or spectrum grid visuals, or visualizer3d.js
  background registration and index.html background-select.
---

# Background effects (Highpersonic3)

Backgrounds fill or decorate the canvas behind foreground geometry. They live under `background/` and are registered on `Visualizer3D.backgrounds`.

## Current registry keys

- `circularWave` — `CircularWaveBackground` (`circularwavebackground.js`).
- `doubleWaveform` — `DoubleWaveformBackground` (`doublewaveformbackground.js`); left/right circular waveforms from stereo `waveformData` channels.
- `gridCells` — `GridCellsBackground` (`gridcellsbackground.js`); primary/secondary colours drive global appearance via `Visualizer3D._syncAppearanceFromGridPalette`.

## Add or change a background

1. **Implement** `background/<name>.js` exporting a class (global name used in `typeof` checks in `visualizer3d.js`).

2. **Load** in `index.html` before `visualizer3d.js` (order relative to other backgrounds can follow existing: circular wave, then grid cells, or group logically).

   ```html
   <script src="background/circularwavebackground.js"></script>
   <script src="background/doublewaveformbackground.js"></script>
   ```

3. **Register** in `visualizer3d.js` `init()`:

   ```text
   if (typeof SomeBackground === "function") {
     const instance = new SomeBackground({ canvas: this.canvas });
     instance.init(this.device, this.format);
     this.backgrounds.set("registryKey", instance);
   }
   ```

4. **UI** — add `<option value="registryKey">` to `#background-select`.

## Contracts

Match existing backgrounds:

- **`init(device, format)`** — create pipelines and buffers.
- **`draw(pass, viewProj, elapsed)`** — render into the current pass (see how `Visualizer3D` orders background vs foreground).
- **`getParameterDescriptors` / `setSettings` / `getSettingsSnapshot`** — optional; `DoubleWaveformBackground` exposes separation-from-centre and ring radius sliders.
- **`setAudioFrame(frame)`** — optional; called when audio analysis updates if implemented.
- **`onActivate` / `onDeactivate`** — optional lifecycle when switching background.
- **Palette** — if you expose RGB primary/secondary, align with `GridCellsBackground`-style hooks so `visualizer3d.js` can sync wave line colour and zoom fade when those features are used.

After adding colours or new side effects, check `_syncAppearanceFromGridPalette` and related methods in `visualizer3d.js` for places that need explicit sync.
