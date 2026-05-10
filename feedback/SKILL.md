---
name: highpersonic3-feedback-effects
description: >-
  Adds or modifies fullscreen feedback / post-process effects (e.g. zoom
  feedback) for Highpersonic3. Use when editing feedback/, fullscreen zoom
  ping-pong buffers, or visualizer3d.js feedback wiring and index.html
  feedback-select.
---

# Feedback effects (Highpersonic3)

Feedback effects are post-process passes that re-use previous frames (e.g. temporal zoom or rotation). Implementations: `feedback/fullscreenzoomeffect.js` (`FullscreenZoomEffect`), `feedback/stainedglassrotationeffect.js` (`StainedGlassRotationEffect`).

## Wiring in the app

- `Visualizer3D` holds **`zoomPost`** and **`stainedGlassPost`** (when script loaded) for `FullscreenZoomEffect` and `StainedGlassRotationEffect`.
- User selection is **`feedbackEffect`**: `"none"`, `"zoom"`, or `"stainedGlass"`.
- When a feedback effect is active, the render path uses ping-pong buffers, then presents; **`fgInFeedback`** includes the foreground in the feedback chain when checked. Stained-glass compose passes **elapsed** time (seconds) for per-frame `dt` in the shader.

## Changing or extending zoom

- **Parameters** — fade colour, scene background sync, and checkbox options (`fadeColorFollowsBackground`, etc.) are surfaced through `zoomPost` methods and `getParameterDescriptors` / `setSettings` patterns in `visualizer3d.js` (scope `"feedback"`, effect key `"zoom"`).
- **Palette** — `setSceneBackgroundColor` and `_syncZoomFadeColorWithBackground` keep clears consistent with `backgroundClearRgb`.

## Add a new feedback type (high level)

1. Implement a new class under `feedback/<name>.js` with `init(device, format, canvas)` and whatever render API fits.
2. Add a field on `Visualizer3D` (similar to `zoomPost`) and branch in the frame loop where zoom is handled today.
3. Extend `setFeedbackEffect` to accept the new token; guard `getEffectParameter` / `setEffectParameter` for the new key.
4. Add `<option>` values to `#feedback-select` and any persisted settings keys in `index.html` if needed.

Prefer mirroring the existing `zoom` integration points so parameter snapshots and the settings drawer stay consistent.
