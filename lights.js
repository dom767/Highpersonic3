/**
 * Central lighting for WGPU lit meshes (grid terrain, D-rings).
 * Direction is in world space; the fragment shader normalizes it.
 */
(function () {
  window.SceneLights = Object.freeze({
    /** @readonly */
    lightDir: Object.freeze([0.46, 0.64, 0.46]),
    /** Minimum shading multiplier (0–1 range in practice). */
    ambient: 0.24,
    /** Diffuse term scaled by max(dot(n, l), 0). */
    diffuse: 0.76
  });
})();
