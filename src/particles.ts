import * as THREE from 'three';
import { GPUFluid } from './fluid';

export function createMatcapTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const imgData = ctx.createImageData(size, size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const nx = (x / (size - 1)) * 2 - 1;
      const ny = -((y / (size - 1)) * 2 - 1);
      const r2 = nx * nx + ny * ny;

      if (r2 <= 1.0) {
        const nz = Math.sqrt(Math.max(0, 1.0 - r2));
        // Soft key light from upper-left
        const lx = -0.35;
        const ly = 0.45;
        const lz = 0.82;
        const lLen = Math.hypot(lx, ly, lz);
        const dot = Math.max(0, (nx * lx + ny * ly + nz * lz) / lLen);

        // Specular highlight
        const hx = lx / lLen;
        const hy = ly / lLen;
        const hz = lz / lLen + 1.0;
        const hLen = Math.hypot(hx, hy, hz);
        const spec = Math.pow(Math.max(0, (nx * hx + ny * hy + nz * hz) / hLen), 14.0);

        // Soft spherical grey shading
        const shade = Math.min(255, Math.max(0, Math.round((0.32 + 0.48 * dot + 0.3 * spec) * 235)));
        imgData.data[idx] = shade;
        imgData.data[idx + 1] = shade;
        imgData.data[idx + 2] = shade;
        imgData.data[idx + 3] = 255;
      } else {
        imgData.data[idx] = 0;
        imgData.data[idx + 1] = 0;
        imgData.data[idx + 2] = 0;
        imgData.data[idx + 3] = 0;
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

const simVertexShader = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const simFragmentShader = `
precision highp float;

varying vec2 vUv;

uniform sampler2D uCurrentPosition;
uniform sampler2D uOriginTexture;
uniform float uTime;
uniform float uHZ;
uniform sampler2D uFluidVelocity;
uniform sampler2D uFluidDensity;
uniform mat4 uProjectionMatrix;
uniform mat4 uModelMatrix;
uniform mat3 uCameraWorldRotation;

// Quaternion rotation
vec3 rotateQuat(vec3 v, vec4 q) {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

// Organic sculpted ring SDF
float sdfShape(vec3 p) {
  if (length(p) > 0.8) return length(p) - 0.7;
  
  // Mirror depth axis: p.z = sqrt(p.z*p.z + 0.0215) - sqrt(0.012)
  p.z = sqrt(p.z * p.z + 0.0215) - sqrt(0.012);
  // Rotate p by quaternion (0.5, 0.5, 0.5, 0.5)
  p = rotateQuat(p, vec4(0.5, 0.5, 0.5, 0.5));
  
  // Bent, hollow ring/torus-like mass with one large opening and softer lobes
  float angle = atan(p.z, p.x);
  float radius = length(p.xz);
  
  // Harmonic waves around the ring for lobes
  float rMod = 0.14 + 0.035 * sin(angle * 3.0 + p.y * 3.5) + 0.025 * cos(angle * 2.0 - p.y * 2.5);
  float RMod = 0.36 + 0.05 * sin(angle * 2.0);
  
  vec2 q = vec2(radius - RMod, p.y + 0.04 * sin(angle * 2.0));
  float d = length(q) - rMod;
  
  // Soft sine surface detail
  d += 0.012 * (sin(p.x * 10.0) * sin(p.y * 10.0) * sin(p.z * 10.0));
  
  return d;
}

vec3 sdfNormal(vec3 p) {
  const float eps = 0.001;
  vec3 n = vec3(
    sdfShape(p + vec3(eps, 0.0, 0.0)) - sdfShape(p - vec3(eps, 0.0, 0.0)),
    sdfShape(p + vec3(0.0, eps, 0.0)) - sdfShape(p - vec3(0.0, eps, 0.0)),
    sdfShape(p + vec3(0.0, 0.0, eps)) - sdfShape(p - vec3(0.0, 0.0, eps))
  );
  return normalize(n + 1e-6);
}

// Analytic curl of three sine-sum potentials (Bridson-style), normalized
vec3 curlNoise(vec3 p) {
  float d_psi_z_dy = -2.0 * sin(p.y * 2.0 + 2.7);
  float d_psi_y_dz =  2.1 * cos(p.z * 2.1 + 2.1);
  
  float d_psi_x_dz = -2.3 * sin(p.z * 2.3 + 0.8);
  float d_psi_z_dx =  2.2 * cos(p.x * 2.2 + 0.5);
  
  float d_psi_y_dx = -1.9 * sin(p.x * 1.9 + 1.4);
  float d_psi_x_dy =  2.0 * cos(p.y * 2.0 + 1.2);
  
  vec3 curl = vec3(
    d_psi_z_dy - d_psi_y_dz,
    d_psi_x_dz - d_psi_z_dx,
    d_psi_y_dx - d_psi_x_dy
  );
  return normalize(curl + 1e-6);
}

void main() {
  vec3 pos = texture2D(uCurrentPosition, vUv).xyz;
  vec3 origin = texture2D(uOriginTexture, vUv).xyz;
  
  if (length(pos) > 0.7) pos /= 2.0;
  pos += curlNoise(pos * 0.1 + uTime * 0.05) * 1.0 * 0.0002 * uHZ;
  vec3 gradient = sdfNormal(pos);
  float sdf = sdfShape(pos);
  pos += cross(normalize(pos + 1e-6), gradient) * 0.0005;
  pos += -gradient * sdf * 0.5;
  pos += (origin - pos) * 0.0002 * uHZ;
  
  // mouse fluid interaction
  vec4 worldPos = uModelMatrix * vec4(pos, 1.0);
  vec4 clipPos = uProjectionMatrix * worldPos;
  vec2 screenUV = (clipPos.xy / clipPos.w) * 0.5 + 0.5;
  
  if (screenUV.x >= 0.0 && screenUV.x <= 1.0 && screenUV.y >= 0.0 && screenUV.y <= 1.0) {
    vec2 fVel = texture2D(uFluidVelocity, screenUV).xy;
    float fDens = texture2D(uFluidDensity, screenUV).r;
    vec3 flow = uCameraWorldRotation * vec3(fVel, 0.0);
    pos += flow * 0.0001 * uHZ * 0.4 * fDens;
  }
  
  gl_FragColor = vec4(pos, 1.0);
}
`;

const copyFragmentShader = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uSource;
void main() {
  gl_FragColor = texture2D(uSource, vUv);
}
`;

const renderVertexShader = `
uniform sampler2D uPositionTexture;
uniform float uTime;
uniform float uDPR;

attribute vec4 aRandom;

varying vec4 vRandom;
varying float vScale;
varying float vDistToCamera;

void main() {
  vRandom = aRandom;
  
  vec2 uv = position.xy;
  vec3 pos = texture2D(uPositionTexture, uv).xyz;
  
  pos *= mix(1.0, 1.5, pow(aRandom.y, 150.0));
  
  vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
  float distToCamera = -mvPosition.z;
  vDistToCamera = distToCamera;
  
  float scale = smoothstep(3.0, 15.0, distToCamera) * mix(0.5, 1.0, aRandom.z);
  vScale = scale;
  
  gl_PointSize = 0.04 * uDPR * 2.0 * scale * (1000.0 / max(distToCamera, 0.01));
  gl_Position = projectionMatrix * mvPosition;
}
`;

const renderFragmentShader = `
precision highp float;

uniform float uTime;
uniform sampler2D uMatcap;

varying vec4 vRandom;
varying float vScale;
varying float vDistToCamera;

vec3 blendSoftLight(vec3 base, vec3 blend) {
  return mix(
    2.0 * base * blend + base * base * (1.0 - 2.0 * blend),
    sqrt(max(base, vec3(0.0))) * (2.0 * blend - 1.0) + 2.0 * base * (1.0 - blend),
    step(0.5, blend)
  );
}

vec3 blendOverlay(vec3 base, vec3 blend) {
  return mix(
    2.0 * base * blend,
    1.0 - 2.0 * (1.0 - base) * (1.0 - blend),
    step(0.5, base)
  );
}

void main() {
  vec2 coord = gl_PointCoord - 0.5;
  if (length(coord) > 0.5) discard;
  if (vScale < 0.1) discard;
  
  // Base colour mix(0.0, 0.2, random.x) grey, mixed to lavender (0.6, 0.45, 1.0) by pow(random.z, 100.0)
  vec3 baseGrey = vec3(mix(0.0, 0.2, vRandom.x));
  vec3 lavender = vec3(0.6, 0.45, 1.0);
  vec3 col = mix(baseGrey, lavender, pow(vRandom.z, 100.0));
  
  // sparkle: 0.5 + (0.4 + sin(time*4.0 + random.y*20.0)) * pow(random.z, 10.0) * 2.5
  float sparkle = 0.5 + (0.4 + sin(uTime * 4.0 + vRandom.y * 20.0)) * pow(vRandom.z, 10.0) * 2.5;
  
  // matcap sampled with the sprite UV rotated by sin(time + random.z*20.0)*0.5 + 1.0, blended soft-light 0.8 then overlay 0.2
  float angle = sin(uTime + vRandom.z * 20.0) * 0.5 + 1.0;
  float c = cos(angle);
  float s = sin(angle);
  vec2 rotCoord = vec2(coord.x * c - coord.y * s, coord.x * s + coord.y * c) + 0.5;
  vec3 matcap = texture2D(uMatcap, rotCoord).rgb;
  
  vec3 blended = mix(col, blendSoftLight(col, matcap), 0.8);
  blended = mix(blended, blendOverlay(blended, matcap), 0.2);
  blended *= sparkle;
  
  gl_FragColor = vec4(blended, 1.0);
}
`;

export class ParticleSystem {
  simSize: number;
  count: number;

  camera: THREE.PerspectiveCamera;
  scene: THREE.Scene;
  pointsGroup: THREE.Group;
  pointsMesh: THREE.Points;

  private posTargetA: THREE.WebGLRenderTarget;
  private posTargetB: THREE.WebGLRenderTarget;
  private currentRead: THREE.WebGLRenderTarget;
  private currentWrite: THREE.WebGLRenderTarget;

  private originTexture: THREE.DataTexture;
  private matcapTexture: THREE.CanvasTexture;

  private simScene: THREE.Scene;
  private simCamera: THREE.OrthographicCamera;
  private simQuadMesh: THREE.Mesh;
  private simMaterial: THREE.ShaderMaterial;

  private copyMaterial: THREE.ShaderMaterial;

  private pointsMaterial: THREE.ShaderMaterial;
  private pointsGeometry: THREE.BufferGeometry;

  private baseCameraPos = new THREE.Vector3(-1.17, 0, 6);
  private cameraTarget = new THREE.Vector3(-1.17, 0, 6);
  private origin = new THREE.Vector3(0, 0, 0);

  private projMatrix = new THREE.Matrix4();
  private cameraWorldRotation = new THREE.Matrix3();

  constructor(isMobile: boolean) {
    this.simSize = isMobile ? 128 : 512;
    this.count = this.simSize * this.simSize;

    // Scene & Camera
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.1, 1000);
    this.camera.position.copy(this.baseCameraPos);
    this.camera.lookAt(this.origin);

    // Group holding the points
    this.pointsGroup = new THREE.Group();
    this.pointsGroup.position.set(0.343, 0.16, -1);
    this.pointsGroup.rotation.set(
      (-28.4 * Math.PI) / 180,
      (390 * Math.PI) / 180,
      (4.92 * Math.PI) / 180
    );
    this.pointsGroup.scale.set(5, 5, 6);
    this.scene.add(this.pointsGroup);

    // Render Targets for Ping-Pong Position
    const rtOptions: THREE.RenderTargetOptions = {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.FloatType,
      depthBuffer: false,
      stencilBuffer: false,
    };
    this.posTargetA = new THREE.WebGLRenderTarget(this.simSize, this.simSize, rtOptions);
    this.posTargetB = new THREE.WebGLRenderTarget(this.simSize, this.simSize, rtOptions);
    this.currentRead = this.posTargetA;
    this.currentWrite = this.posTargetB;

    // Origin Texture (uniform random in [-1, 1]³)
    const originData = new Float32Array(this.count * 4);
    for (let i = 0; i < this.count; i++) {
      originData[i * 4 + 0] = Math.random() * 2.0 - 1.0;
      originData[i * 4 + 1] = Math.random() * 2.0 - 1.0;
      originData[i * 4 + 2] = Math.random() * 2.0 - 1.0;
      originData[i * 4 + 3] = 1.0;
    }
    this.originTexture = new THREE.DataTexture(
      originData,
      this.simSize,
      this.simSize,
      THREE.RGBAFormat,
      THREE.FloatType
    );
    this.originTexture.needsUpdate = true;

    // Matcap Texture
    this.matcapTexture = createMatcapTexture();

    // Simulation Setup
    this.simCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.simScene = new THREE.Scene();
    const quadGeom = new THREE.PlaneGeometry(2, 2);
    this.simQuadMesh = new THREE.Mesh(quadGeom);
    this.simScene.add(this.simQuadMesh);

    this.simMaterial = new THREE.ShaderMaterial({
      vertexShader: simVertexShader,
      fragmentShader: simFragmentShader,
      uniforms: {
        uCurrentPosition: { value: null },
        uOriginTexture: { value: this.originTexture },
        uTime: { value: 0 },
        uHZ: { value: 1.0 },
        uFluidVelocity: { value: null },
        uFluidDensity: { value: null },
        uProjectionMatrix: { value: new THREE.Matrix4() },
        uModelMatrix: { value: new THREE.Matrix4() },
        uCameraWorldRotation: { value: new THREE.Matrix3() },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.copyMaterial = new THREE.ShaderMaterial({
      vertexShader: simVertexShader,
      fragmentShader: copyFragmentShader,
      uniforms: {
        uSource: { value: this.originTexture },
      },
      depthTest: false,
      depthWrite: false,
    });

    // Points Geometry & Material
    this.pointsGeometry = new THREE.BufferGeometry();
    const positions = new Float32Array(this.count * 3);
    const randoms = new Float32Array(this.count * 4);

    for (let i = 0; i < this.count; i++) {
      const u = (i % this.simSize + 0.5) / this.simSize;
      const v = (Math.floor(i / this.simSize) + 0.5) / this.simSize;
      positions[i * 3 + 0] = u;
      positions[i * 3 + 1] = v;
      positions[i * 3 + 2] = 0.0;

      randoms[i * 4 + 0] = Math.random();
      randoms[i * 4 + 1] = Math.random();
      randoms[i * 4 + 2] = Math.random();
      randoms[i * 4 + 3] = Math.random();
    }

    this.pointsGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.pointsGeometry.setAttribute('aRandom', new THREE.BufferAttribute(randoms, 4));

    this.pointsMaterial = new THREE.ShaderMaterial({
      vertexShader: renderVertexShader,
      fragmentShader: renderFragmentShader,
      uniforms: {
        uPositionTexture: { value: null },
        uTime: { value: 0 },
        uDPR: { value: Math.min(window.devicePixelRatio, 2) },
        uMatcap: { value: this.matcapTexture },
      },
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthTest: true,
      depthWrite: false,
    });

    this.pointsMesh = new THREE.Points(this.pointsGeometry, this.pointsMaterial);
    this.pointsGroup.add(this.pointsMesh);
  }

  initTargets(renderer: THREE.WebGLRenderer) {
    // Fill both targets with initial random origin data
    this.simQuadMesh.material = this.copyMaterial;
    this.copyMaterial.uniforms.uSource.value = this.originTexture;

    renderer.setRenderTarget(this.posTargetA);
    renderer.render(this.simScene, this.simCamera);

    renderer.setRenderTarget(this.posTargetB);
    renderer.render(this.simScene, this.simCamera);

    renderer.setRenderTarget(null);
  }

  updateGaze(mouseX: number, mouseY: number, width: number, height: number) {
    const ndcX = (mouseX / width) * 2.0 - 1.0;
    const ndcY = (mouseY / height) * 2.0 - 1.0;

    // Section 7 gaze formula:
    // base + (mouse.x mapped 0..width → -1..1) × (-1) on x and (mouse.y mapped 0..height → -1..1) × 2 on y
    this.cameraTarget.x = this.baseCameraPos.x + ndcX * -1.0;
    this.cameraTarget.y = this.baseCameraPos.y + ndcY * 2.0;
    this.cameraTarget.z = this.baseCameraPos.z;

    this.camera.position.lerp(this.cameraTarget, 0.05);
    this.camera.lookAt(this.origin);
  }

  step(renderer: THREE.WebGLRenderer, time: number, dt: number, fluid: GPUFluid) {
    const HZ = Math.min(dt * 60.0, 2.0);

    // Update group and camera matrices
    this.pointsGroup.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);

    // Calculate projection * inverse camera world
    this.projMatrix.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);

    // Camera world rotation (normal matrix)
    this.cameraWorldRotation.setFromMatrix4(this.camera.matrixWorld);

    // 1. Simulation step
    this.simQuadMesh.material = this.simMaterial;
    this.simMaterial.uniforms.uCurrentPosition.value = this.currentRead.texture;
    this.simMaterial.uniforms.uOriginTexture.value = this.originTexture;
    this.simMaterial.uniforms.uTime.value = time;
    this.simMaterial.uniforms.uHZ.value = HZ;
    this.simMaterial.uniforms.uFluidVelocity.value = fluid.velocityTexture;
    this.simMaterial.uniforms.uFluidDensity.value = fluid.densityTexture;
    this.simMaterial.uniforms.uProjectionMatrix.value.copy(this.projMatrix);
    this.simMaterial.uniforms.uModelMatrix.value.copy(this.pointsGroup.matrixWorld);
    this.simMaterial.uniforms.uCameraWorldRotation.value.copy(this.cameraWorldRotation);

    renderer.setRenderTarget(this.currentWrite);
    renderer.render(this.simScene, this.simCamera);

    // Swap position targets
    const temp = this.currentRead;
    this.currentRead = this.currentWrite;
    this.currentWrite = temp;

    // 2. Render points to screen
    this.pointsMaterial.uniforms.uPositionTexture.value = this.currentRead.texture;
    this.pointsMaterial.uniforms.uTime.value = time;
    this.pointsMaterial.uniforms.uDPR.value = Math.min(window.devicePixelRatio, 2);

    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.camera);
  }

  resize(width: number, height: number) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.posTargetA.dispose();
    this.posTargetB.dispose();
    this.originTexture.dispose();
    this.matcapTexture.dispose();
    this.pointsGeometry.dispose();
    this.pointsMaterial.dispose();
    this.simMaterial.dispose();
    this.copyMaterial.dispose();
    this.simQuadMesh.geometry.dispose();
  }
}
