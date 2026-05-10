/**
 * Default scene lighting. `Visualizer3D` clones this into mutable app state and
 * pushes updates to each foreground via `setSceneLights`.
 */
(function () {
  window.SceneLightingDefaults = Object.freeze({
    lightDir: Object.freeze([0.46, 0.64, 0.46]),
    ambient: 0.24,
    diffuse: 0.76
  });
})();
