---
name: highpersonic3-beat-effects
description: >-
  Adds or modifies bass-drum-triggered beat post-process effects for
  Highpersonic3. Use when editing beat/, interlaced split, bassBeat
  wiring, visualizer3d.js beat integration, or index.html beat-select.
---

# Beat effects (Highpersonic3)

Beat effects are fullscreen post-process passes triggered by `frame.bassBeat` from `AudioCore`. They run as the **final pass** after the normal render path (feedback, background, foreground) and stack with feedback effects.

Implementations: `beat/interlacedspliteffect.js` (`InterlacedSplitEffect`), `beat/rgbchannelspliteffect.js` (`RgbChannelSplitEffect`).

## Wiring in the app

- `Visualizer3D` holds **`interlacedSplitPost`** and **`rgbChannelSplitPost`** (when scripts loaded).
- User selection is **`beatEffect`**: `"none"`, `"interlacedSplit"`, or `"rgbChannelSplit"`.
- On each audio frame, if `frame.bassBeat` and the active beat effect is selected, `trigger()` is called on the instance.
- Each render frame, `update(dt)` decays the effect; the scene renders into a **resolve texture** (`getRenderTargetView()`), then `presentToSwapchain(encoder, swapchainView)` samples it and writes to the canvas (swapchain textures cannot be copied or sampled).

## Beat effect contract

Match existing beat implementations:

- **`init(device, format, canvas)`** — create pipelines, snapshot texture, uniforms.
- **`resize()`** — recreate snapshot texture when canvas size changes.
- **`trigger()`** — snap effect intensity to maximum (called on `bassBeat`).
- **`update(dt)`** — exponential decay each frame (seconds).
- **`getRenderTargetView()`** — offscreen colour target for the scene while this beat effect is selected (required because the swapchain is not sampleable).
- **`presentToSwapchain(encoder, swapchainView)`** — final blit/post to the canvas.
- **`reset()`** — clear state when switching beat effect off/on.
- **`getParameterDescriptors` / `setSettings` / `getSettingsSnapshot`** — optional; surfaced in the effect settings panel (scope `"beat"`, effect key e.g. `"interlacedSplit"`).

## Add a new beat type (high level)

1. Implement a new class under `beat/<name>.js` following the contract above.
2. Add a field on `Visualizer3D` (similar to `interlacedSplitPost`) and call it from `_render()` after the scene is on the swapchain.
3. Extend `setBeatEffect` to accept the new token; guard `applyEffectSettings` / `getEffectSettingsSnapshot` for the new key.
4. In `setAudioFrame`, call `trigger()` when `frame.bassBeat` and the new effect is active.
5. Add `<option>` values to `#beat-select` and persisted settings keys in `index.html` if needed.

Prefer mirroring the existing `interlacedSplit` integration points so parameter snapshots and the settings drawer stay consistent.
