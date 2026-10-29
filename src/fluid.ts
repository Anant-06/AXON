import * as THREE from 'three';

const baseVertexShader = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const splatShader = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTarget;
uniform float uAspectRatio;
uniform vec2 uPoint0;
uniform vec2 uPoint1;
uniform vec3 uColor;
uniform float uRadius;

float distToSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}

void main() {
  vec2 p = vUv;
  vec2 p0 = uPoint0;
  vec2 p1 = uPoint1;
  p.x *= uAspectRatio;
  p0.x *= uAspectRatio;
  p1.x *= uAspectRatio;

  float d = distToSegment(p, p0, p1);
  float intensity = exp(-d * d / max(2.0 * uRadius * uRadius, 1e-6));
  vec4 base = texture2D(uTarget, vUv);
  gl_FragColor = base + vec4(uColor * intensity, intensity);
}
`;

const curlShader = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uVelocity;
uniform vec2 uTexelSize;

void main() {
  float L = texture2D(uVelocity, vUv - vec2(uTexelSize.x, 0.0)).y;
  float R = texture2D(uVelocity, vUv + vec2(uTexelSize.x, 0.0)).y;
  float B = texture2D(uVelocity, vUv - vec2(0.0, uTexelSize.y)).x;
  float T = texture2D(uVelocity, vUv + vec2(0.0, uTexelSize.y)).x;
  float curl = 0.5 * (R - L - (T - B));
  gl_FragColor = vec4(curl, 0.0, 0.0, 1.0);
}
`;

const vorticityShader = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform float uCurlStrength;
uniform float uDt;
uniform vec2 uTexelSize;

void main() {
  float L = texture2D(uCurl, vUv - vec2(uTexelSize.x, 0.0)).x;
  float R = texture2D(uCurl, vUv + vec2(uTexelSize.x, 0.0)).x;
  float B = texture2D(uCurl, vUv - vec2(0.0, uTexelSize.y)).x;
  float T = texture2D(uCurl, vUv + vec2(0.0, uTexelSize.y)).x;
  float C = texture2D(uCurl, vUv).x;

  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  float len = length(force) + 1e-5;
  force = (force / len) * vec2(1.0, -1.0) * C * uCurlStrength;
  
  vec2 vel = texture2D(uVelocity, vUv).xy;
  gl_FragColor = vec4(vel + force * uDt, 0.0, 1.0);
}
`;

const divergenceShader = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uVelocity;
uniform vec2 uTexelSize;

void main() {
  float L = texture2D(uVelocity, vUv - vec2(uTexelSize.x, 0.0)).x;
  float R = texture2D(uVelocity, vUv + vec2(uTexelSize.x, 0.0)).x;
  float B = texture2D(uVelocity, vUv - vec2(0.0, uTexelSize.y)).y;
  float T = texture2D(uVelocity, vUv + vec2(0.0, uTexelSize.y)).y;
  float div = 0.5 * (R - L + T - B);
  gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
}
`;

const pressureShader = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
uniform vec2 uTexelSize;
uniform float uDissipation;

void main() {
  float L = texture2D(uPressure, vUv - vec2(uTexelSize.x, 0.0)).x;
  float R = texture2D(uPressure, vUv + vec2(uTexelSize.x, 0.0)).x;
  float B = texture2D(uPressure, vUv - vec2(0.0, uTexelSize.y)).x;
  float T = texture2D(uPressure, vUv + vec2(0.0, uTexelSize.y)).x;
  float div = texture2D(uDivergence, vUv).x;
  float p = (L + R + B + T - div) * 0.25 * uDissipation;
  gl_FragColor = vec4(p, 0.0, 0.0, 1.0);
}
`;

const gradientSubtractShader = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uVelocity;
uniform sampler2D uPressure;
uniform vec2 uTexelSize;

void main() {
  float L = texture2D(uPressure, vUv - vec2(uTexelSize.x, 0.0)).x;
  float R = texture2D(uPressure, vUv + vec2(uTexelSize.x, 0.0)).x;
  float B = texture2D(uPressure, vUv - vec2(0.0, uTexelSize.y)).x;
  float T = texture2D(uPressure, vUv + vec2(0.0, uTexelSize.y)).x;
  vec2 vel = texture2D(uVelocity, vUv).xy;
  vel -= 0.5 * vec2(R - L, T - B);
  gl_FragColor = vec4(vel, 0.0, 1.0);
}
`;

const advectionShader = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 uTexelSize;
uniform float uDt;
uniform float uDissipation;

void main() {
  vec2 vel = texture2D(uVelocity, vUv).xy;
  vec2 coord = vUv - uDt * vel * uTexelSize;
  vec4 result = texture2D(uSource, coord) * uDissipation;
  gl_FragColor = result;
}
`;

class DoubleRenderTarget {
  read: THREE.WebGLRenderTarget;
  write: THREE.WebGLRenderTarget;

  constructor(width: number, height: number, options: THREE.RenderTargetOptions) {
    this.read = new THREE.WebGLRenderTarget(width, height, options);
    this.write = new THREE.WebGLRenderTarget(width, height, options);
  }

  swap() {
    const temp = this.read;
    this.read = this.write;
    this.write = temp;
  }

  dispose() {
    this.read.dispose();
    this.write.dispose();
  }
}

export interface SplatEvent {
  p0: { x: number; y: number };
  p1: { x: number; y: number };
  color: { r: number; g: number; b: number };
  radius: number;
}

export class GPUFluid {
  simRes = 256;
  dyeRes = 512;

  velocityDissipation = 0.98;
  densityDissipation = 0.97;
  pressureDissipation = 0.95;
  pressureIterations = 5;
  curlStrength = 30.0;
  dt = 1.0 / 60.0;

  velocity: DoubleRenderTarget;
  density: DoubleRenderTarget;
  curlTarget: THREE.WebGLRenderTarget;
  divergenceTarget: THREE.WebGLRenderTarget;
  pressure: DoubleRenderTarget;

  private quadScene: THREE.Scene;
  private orthoCamera: THREE.OrthographicCamera;
  private quadMesh: THREE.Mesh;

  private splatMat: THREE.ShaderMaterial;
  private curlMat: THREE.ShaderMaterial;
  private vorticityMat: THREE.ShaderMaterial;
  private divergenceMat: THREE.ShaderMaterial;
  private pressureMat: THREE.ShaderMaterial;
  private gradSubtractMat: THREE.ShaderMaterial;
  private advectVelocityMat: THREE.ShaderMaterial;
  private advectDensityMat: THREE.ShaderMaterial;

  private splatQueue: SplatEvent[] = [];

  constructor() {
    const floatType = THREE.HalfFloatType;
    const rtOptions: THREE.RenderTargetOptions = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: floatType,
      depthBuffer: false,
      stencilBuffer: false,
    };

    this.velocity = new DoubleRenderTarget(this.simRes, this.simRes, rtOptions);
    this.density = new DoubleRenderTarget(this.dyeRes, this.dyeRes, rtOptions);
    this.curlTarget = new THREE.WebGLRenderTarget(this.simRes, this.simRes, rtOptions);
    this.divergenceTarget = new THREE.WebGLRenderTarget(this.simRes, this.simRes, rtOptions);
    this.pressure = new DoubleRenderTarget(this.simRes, this.simRes, rtOptions);

    this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quadScene = new THREE.Scene();
    const geom = new THREE.PlaneGeometry(2, 2);
    this.quadMesh = new THREE.Mesh(geom);
    this.quadScene.add(this.quadMesh);

    // Materials
    this.splatMat = new THREE.ShaderMaterial({
      vertexShader: baseVertexShader,
      fragmentShader: splatShader,
      uniforms: {
        uTarget: { value: null },
        uAspectRatio: { value: 1.0 },
        uPoint0: { value: new THREE.Vector2() },
        uPoint1: { value: new THREE.Vector2() },
        uColor: { value: new THREE.Vector3() },
        uRadius: { value: 0.01 },
      },
      depthTest: false,
      depthWrite: false,
    });

    const simTexel = new THREE.Vector2(1.0 / this.simRes, 1.0 / this.simRes);
    const dyeTexel = new THREE.Vector2(1.0 / this.dyeRes, 1.0 / this.dyeRes);

    this.curlMat = new THREE.ShaderMaterial({
      vertexShader: baseVertexShader,
      fragmentShader: curlShader,
      uniforms: {
        uVelocity: { value: null },
        uTexelSize: { value: simTexel },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.vorticityMat = new THREE.ShaderMaterial({
      vertexShader: baseVertexShader,
      fragmentShader: vorticityShader,
      uniforms: {
        uVelocity: { value: null },
        uCurl: { value: null },
        uCurlStrength: { value: this.curlStrength },
        uDt: { value: this.dt },
        uTexelSize: { value: simTexel },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.divergenceMat = new THREE.ShaderMaterial({
      vertexShader: baseVertexShader,
      fragmentShader: divergenceShader,
      uniforms: {
        uVelocity: { value: null },
        uTexelSize: { value: simTexel },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.pressureMat = new THREE.ShaderMaterial({
      vertexShader: baseVertexShader,
      fragmentShader: pressureShader,
      uniforms: {
        uPressure: { value: null },
        uDivergence: { value: null },
        uTexelSize: { value: simTexel },
        uDissipation: { value: this.pressureDissipation },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.gradSubtractMat = new THREE.ShaderMaterial({
      vertexShader: baseVertexShader,
      fragmentShader: gradientSubtractShader,
      uniforms: {
        uVelocity: { value: null },
        uPressure: { value: null },
        uTexelSize: { value: simTexel },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.advectVelocityMat = new THREE.ShaderMaterial({
      vertexShader: baseVertexShader,
      fragmentShader: advectionShader,
      uniforms: {
        uVelocity: { value: null },
        uSource: { value: null },
        uTexelSize: { value: simTexel },
        uDt: { value: this.dt },
        uDissipation: { value: this.velocityDissipation },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.advectDensityMat = new THREE.ShaderMaterial({
      vertexShader: baseVertexShader,
      fragmentShader: advectionShader,
      uniforms: {
        uVelocity: { value: null },
        uSource: { value: null },
        uTexelSize: { value: dyeTexel },
        uDt: { value: this.dt },
        uDissipation: { value: this.densityDissipation },
      },
      depthTest: false,
      depthWrite: false,
    });
  }

  private blit(renderer: THREE.WebGLRenderer, destination: THREE.WebGLRenderTarget | null, material: THREE.Material) {
    this.quadMesh.material = material;
    renderer.setRenderTarget(destination);
    renderer.render(this.quadScene, this.orthoCamera);
  }

  addSplat(p0: { x: number; y: number }, p1: { x: number; y: number }, color: { r: number; g: number; b: number }, radius: number) {
    this.splatQueue.push({ p0, p1, color, radius });
  }

  step(renderer: THREE.WebGLRenderer, aspectRatio: number) {
    // 1. Process splats
    while (this.splatQueue.length > 0) {
      const splat = this.splatQueue.shift()!;
      // Splat into velocity
      this.splatMat.uniforms.uTarget.value = this.velocity.read.texture;
      this.splatMat.uniforms.uAspectRatio.value = aspectRatio;
      this.splatMat.uniforms.uPoint0.value.set(splat.p0.x, splat.p0.y);
      this.splatMat.uniforms.uPoint1.value.set(splat.p1.x, splat.p1.y);
      this.splatMat.uniforms.uColor.value.set(splat.color.r, splat.color.g, splat.color.b);
      this.splatMat.uniforms.uRadius.value = splat.radius;
      this.blit(renderer, this.velocity.write, this.splatMat);
      this.velocity.swap();

      // Splat into density (white)
      this.splatMat.uniforms.uTarget.value = this.density.read.texture;
      this.splatMat.uniforms.uColor.value.set(1.0, 1.0, 1.0);
      this.blit(renderer, this.density.write, this.splatMat);
      this.density.swap();
    }

    // 2. Compute Curl
    this.curlMat.uniforms.uVelocity.value = this.velocity.read.texture;
    this.blit(renderer, this.curlTarget, this.curlMat);

    // 3. Vorticity Confinement
    this.vorticityMat.uniforms.uVelocity.value = this.velocity.read.texture;
    this.vorticityMat.uniforms.uCurl.value = this.curlTarget.texture;
    this.blit(renderer, this.velocity.write, this.vorticityMat);
    this.velocity.swap();

    // 4. Compute Divergence
    this.divergenceMat.uniforms.uVelocity.value = this.velocity.read.texture;
    this.blit(renderer, this.divergenceTarget, this.divergenceMat);

    // 5. Pressure Poisson Solve (Jacobi)
    this.pressureMat.uniforms.uDivergence.value = this.divergenceTarget.texture;
    for (let i = 0; i < this.pressureIterations; i++) {
      this.pressureMat.uniforms.uPressure.value = this.pressure.read.texture;
      this.blit(renderer, this.pressure.write, this.pressureMat);
      this.pressure.swap();
    }

    // 6. Subtract Pressure Gradient
    this.gradSubtractMat.uniforms.uVelocity.value = this.velocity.read.texture;
    this.gradSubtractMat.uniforms.uPressure.value = this.pressure.read.texture;
    this.blit(renderer, this.velocity.write, this.gradSubtractMat);
    this.velocity.swap();

    // 7. Advect Velocity
    this.advectVelocityMat.uniforms.uVelocity.value = this.velocity.read.texture;
    this.advectVelocityMat.uniforms.uSource.value = this.velocity.read.texture;
    this.blit(renderer, this.velocity.write, this.advectVelocityMat);
    this.velocity.swap();

    // 8. Advect Density
    this.advectDensityMat.uniforms.uVelocity.value = this.velocity.read.texture;
    this.advectDensityMat.uniforms.uSource.value = this.density.read.texture;
    this.blit(renderer, this.density.write, this.advectDensityMat);
    this.density.swap();
  }

  get velocityTexture(): THREE.Texture {
    return this.velocity.read.texture;
  }

  get densityTexture(): THREE.Texture {
    return this.density.read.texture;
  }

  dispose() {
    this.velocity.dispose();
    this.density.dispose();
    this.curlTarget.dispose();
    this.divergenceTarget.dispose();
    this.pressure.dispose();
    this.quadMesh.geometry.dispose();
    this.splatMat.dispose();
    this.curlMat.dispose();
    this.vorticityMat.dispose();
    this.divergenceMat.dispose();
    this.pressureMat.dispose();
    this.gradSubtractMat.dispose();
    this.advectVelocityMat.dispose();
    this.advectDensityMat.dispose();
  }
}
