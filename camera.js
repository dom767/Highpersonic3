(() => {
  function mat4Perspective(fovY, aspect, near, far) {
    const out = new Float32Array(16);
    const f = 1 / Math.tan(fovY * 0.5);
    out[0] = f / aspect;
    out[5] = f;
    out[11] = -1;
    if (Number.isFinite(far)) {
      const nf = 1 / (near - far);
      out[10] = far * nf;
      out[14] = far * near * nf;
    } else {
      out[10] = -1;
      out[14] = -near;
    }
    return out;
  }

  function mat4LookAt(eye, target, up) {
    const out = new Float32Array(16);
    let z0 = eye[0] - target[0];
    let z1 = eye[1] - target[1];
    let z2 = eye[2] - target[2];
    let len = 1 / Math.hypot(z0, z1, z2);
    z0 *= len;
    z1 *= len;
    z2 *= len;

    let x0 = up[1] * z2 - up[2] * z1;
    let x1 = up[2] * z0 - up[0] * z2;
    let x2 = up[0] * z1 - up[1] * z0;
    len = Math.hypot(x0, x1, x2);
    if (len > 0) {
      len = 1 / len;
      x0 *= len;
      x1 *= len;
      x2 *= len;
    }

    let y0 = z1 * x2 - z2 * x1;
    let y1 = z2 * x0 - z0 * x2;
    let y2 = z0 * x1 - z1 * x0;
    len = Math.hypot(y0, y1, y2);
    if (len > 0) {
      len = 1 / len;
      y0 *= len;
      y1 *= len;
      y2 *= len;
    }

    out[0] = x0; out[1] = y0; out[2] = z0; out[3] = 0;
    out[4] = x1; out[5] = y1; out[6] = z1; out[7] = 0;
    out[8] = x2; out[9] = y2; out[10] = z2; out[11] = 0;
    out[12] = -(x0 * eye[0] + x1 * eye[1] + x2 * eye[2]);
    out[13] = -(y0 * eye[0] + y1 * eye[1] + y2 * eye[2]);
    out[14] = -(z0 * eye[0] + z1 * eye[1] + z2 * eye[2]);
    out[15] = 1;
    return out;
  }

  function mat4Multiply(a, b) {
    const out = new Float32Array(16);
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

    for (let col = 0; col < 4; col++) {
      const b0 = b[col * 4 + 0];
      const b1 = b[col * 4 + 1];
      const b2 = b[col * 4 + 2];
      const b3 = b[col * 4 + 3];
      out[col * 4 + 0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
      out[col * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
      out[col * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
      out[col * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    }
    return out;
  }

  class OrbitCamera {
    constructor(options = {}) {
      this.elevation = options.elevation ?? (Math.PI / 4);
      this.minElevation = options.minElevation ?? (35 * Math.PI / 180);
      this.maxElevation = options.maxElevation ?? (50 * Math.PI / 180);
      this.radius = options.radius ?? 5.5;
      this.angularSpeed = options.angularSpeed ?? 0.25;
      this.target = options.target ?? [0, 0.4, 0];
      this.up = options.up ?? [0, 1, 0];
      this.fovY = options.fovY ?? (Math.PI / 4);
      this.near = options.near ?? 0.1;
      this.far = options.far ?? 100;
      this.angle = 0;
      this.lastElapsedSeconds = null;
    }

    resetMotion() {
      this.angle = 0;
      this.lastElapsedSeconds = null;
    }

    getViewProjection(elapsedSeconds, aspect, modulation = {}) {
      const bassSustain = Math.max(0, Math.min(1, Number(modulation.bassSustain) || 0));
      const trebleSustain = Math.max(0, Math.min(1, Number(modulation.trebleSustain) || 0));

      // Integrate angle over time so bass controls rotation velocity (0x..1x).
      const dt = this.lastElapsedSeconds == null
        ? 0
        : Math.max(0, elapsedSeconds - this.lastElapsedSeconds);
      this.lastElapsedSeconds = elapsedSeconds;
      this.angle += dt * this.angularSpeed * bassSustain;

      const elevation = this.minElevation + (this.maxElevation - this.minElevation) * trebleSustain;
      const angle = this.angle;
      const eye = [
        Math.cos(angle) * this.radius * Math.cos(elevation),
        Math.sin(elevation) * this.radius,
        Math.sin(angle) * this.radius * Math.cos(elevation)
      ];

      const projection = mat4Perspective(this.fovY, aspect, this.near, this.far);
      const view = mat4LookAt(eye, this.target, this.up);
      return mat4Multiply(projection, view);
    }
  }

  window.OrbitCamera = OrbitCamera;
})();
