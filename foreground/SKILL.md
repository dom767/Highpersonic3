---
name: highpersonic3-foreground-effects
description: >-
  Adds or modifies WebGPU foreground effects (3D spectrum-driven layers) for
  Highpersonic3. Use when implementing or editing files under foreground/,
  wiring GridWireframeRenderer/DRingsRenderer-style modules, or changing
  visualizer3d.js foreground registration or index.html foreground-select.
---

# Foreground effects (Highpersonic3)

Foregrounds render the main 3D scene content (camera orbit, spectrum height/grid, materials). They live under `foreground/` and are registered on `Visualizer3D.foregrounds`.

## Add or change a foreground

1. **Implement** a module in `foreground/<name>.js` that attaches its public class to `window` if needed for `typeof` guards (match existing patterns such as `DRingsRenderer`).

2. **Load** the script in `index.html` before `visualizer3d.js`, after `lights.js` (lighting defaults), e.g.:

   ```html
   <script src="foreground/gridrenderer.js"></script>
   ```

3. **Register** in `visualizer3d.js` inside `init()` after `this.device` exists:

   - Construct the renderer with `this.device`, `this.format` as required.
   - Call `this.foregrounds.set("<registryKey>", instance)` (keys are camelCase: `wireframeGrid`, `dRings`).

4. **UI** — add an `<option value="<registryKey>">` to `#foreground-select` in `index.html` if users should pick it.

## Contracts the visualizer expects

Consult existing implementations in this folder:

- **`draw(pass, viewProj, elapsed)`** — required for rendering.
- **`init(...)`** — one-time GPU setup after device is ready.
- **`setSceneLights({ lightDir, ambient, diffuse })`** — called when lighting changes; copy from `GridWireframeRenderer` if your shader uses Lambert-style lighting.
- **`setSpectrumTexture(texture)`** — optional; called when the primary texture asset changes.
- **`pushSpectrum` / `clearHistory` / `setSettings`** — wired from `Visualizer3D` for audio/UI; implement if the effect exposes tunable behavior.
- **Parameter UI** — if the effect exposes user parameters, implement `getParameterDescriptors` / `getSettingsSnapshot` / `setSettings` consistent with other foregrounds so the settings drawer stays in sync.

## Related files

- `visualizer3d.js` — `foregrounds` map, `setForeground`, render loop calling `foreground.draw`.
- `lights.js` — `SceneLightingDefaults` consumed by foregrounds.
- `audiocore.js` — spectrum data path into the visualizer (not usually edited for a new look).
