(() => {
  // BackgroundEffect contract:
  //   init(device, format)            - one-time GPU resource setup
  //   getClearValue()                 - returns { r, g, b, a } for the render pass clear
  //   draw(passEncoder, viewProj, t)  - optional per-frame draws after clear
  // Effects that need to read the previous frame (e.g. zoomfade) will later
  // extend this contract with an offscreen scene texture pipeline.

  const DEFAULT_COLOR = { r: 0.965, g: 0.96, b: 0.985, a: 1.0 };

  class SolidColorBackground {
    constructor(color) {
      this.color = { ...DEFAULT_COLOR, ...(color || {}) };
    }

    init(_device, _format) {
      // No GPU resources required for a clear-only background.
    }

    setColor(color) {
      this.color = { ...this.color, ...(color || {}) };
    }

    getClearValue() {
      return this.color;
    }

    draw(_passEncoder, _viewProj, _elapsedSeconds) {
      // Solid color is realized purely via the render pass clear value.
    }
  }

  window.SolidColorBackground = SolidColorBackground;
})();
