import {
  BufferAttribute,
  BufferGeometry,
  AmbientLight,
  Color,
  DirectionalLight,
  Group,
  Matrix4,
  Mesh,
  MeshPhongMaterial,
  OrthographicCamera,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Texture,
  CanvasTexture,
  Vector3,
  Vector2,
  DoubleSide,
  RepeatWrapping,
  WebGLRenderer,
} from 'three';
import { geoEquirectangular, geoGraticule10, geoPath, geoRotation, type GeoPermissibleObjects } from 'd3-geo';
import type { FeatureCollection } from 'geojson';
import { projectLocation, type FlatCamera } from './atlas-camera';

export interface GlobeFrame {
  longitude: number;
  latitude: number;
  radius: number;
  center: [number, number];
  width: number;
  height: number;
  morph: number;
  flatCamera: FlatCamera;
}

const TAU = Math.PI * 2;
const EQUAL_EARTH_SEAM_OFFSET = Math.PI / 15; // 12 degrees: atlasProjection.rotate([-12, 0])

function makeSphereGrid(): BufferGeometry {
  const longitudeSteps = 256;
  const latitudeSteps = 128;
  const positions: number[] = [];
  const uvs: number[] = [];
  const flatLocations: number[] = [];
  const indices: number[] = [];
  for (let row = 0; row <= latitudeSteps; row += 1) {
    const latitude = -Math.PI / 2 + Math.PI * row / latitudeSteps;
    const cosLatitude = Math.cos(latitude);
    for (let column = 0; column <= longitudeSteps; column += 1) {
      const longitude = -Math.PI + EQUAL_EARTH_SEAM_OFFSET + TAU * column / longitudeSteps;
      positions.push(cosLatitude * Math.sin(longitude), Math.sin(latitude), cosLatitude * Math.cos(longitude));
      uvs.push(column / longitudeSteps + 12 / 360, row / latitudeSteps);
      const flatLongitude = longitude * 180 / Math.PI;
      const flatLatitude = latitude * 180 / Math.PI;
      let flat = projectLocation([flatLongitude, flatLatitude]);
      if (column === longitudeSteps) {
        // D3 wraps 192 degrees to -168 at the seam; extrapolate the continuous right edge.
        const stepDegrees = 360 / longitudeSteps;
        const previous = projectLocation([flatLongitude - stepDegrees, flatLatitude]);
        const previous2 = projectLocation([flatLongitude - 2 * stepDegrees, flatLatitude]);
        flat = [previous[0] + previous[0] - previous2[0], flat[1]];
      }
      flatLocations.push(flat[0], flat[1]);
    }
  }
  for (let row = 0; row < latitudeSteps; row += 1) {
    for (let column = 0; column < longitudeSteps; column += 1) {
      const a = row * (longitudeSteps + 1) + column;
      const b = a + 1;
      const c = a + longitudeSteps + 1;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setAttribute('flatLocation', new BufferAttribute(new Float32Array(flatLocations), 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function makeMapTexture(world: FeatureCollection): CanvasTexture | null {
  const canvas = document.createElement('canvas');
  canvas.width = 4096;
  canvas.height = 2048;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.fillStyle = '#8FAFB6';
  context.fillRect(0, 0, canvas.width, canvas.height);

  const projection = geoEquirectangular().scale(canvas.width / (2 * Math.PI)).translate([canvas.width / 2, canvas.height / 2]);
  const path = geoPath(projection, context);
  for (const feature of world.features) {
    context.beginPath();
    path(feature as GeoPermissibleObjects);
    context.fillStyle = '#E7DCC6';
    context.fill();
    context.strokeStyle = '#B5AC96';
    context.lineWidth = 1.15;
    context.stroke();
  }

  context.beginPath();
  path(geoGraticule10());
  context.strokeStyle = 'rgba(63, 99, 108, 0.17)';
  context.lineWidth = 1;
  context.stroke();

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = 'srgb';
  texture.wrapS = RepeatWrapping;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

function rotationMatrix(longitude: number, latitude: number): Matrix4 {
  const rotate = geoRotation([-longitude, -latitude]);
  const toGlobe = (coordinate: [number, number]) => {
    const [lon, lat] = rotate(coordinate);
    const lonRadians = lon * Math.PI / 180;
    const latRadians = lat * Math.PI / 180;
    const cosLat = Math.cos(latRadians);
    return new Vector3(cosLat * Math.sin(lonRadians), Math.sin(latRadians), cosLat * Math.cos(lonRadians));
  };
  // Three's local x/y/z basis corresponds to geographic [90,0], [0,90], [0,0].
  const x = toGlobe([90, 0]);
  const y = toGlobe([0, 90]);
  const z = toGlobe([0, 0]);
  return new Matrix4().set(
    x.x, y.x, z.x, 0,
    x.y, y.y, z.y, 0,
    x.z, y.z, z.z, 0,
    0, 0, 0, 1,
  );
}

export function createGlobeRenderer(canvas: HTMLCanvasElement, world: FeatureCollection): { render(frame: GlobeFrame): void; dispose(): void } | null {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
  } catch {
    return null;
  }

  const scene = new Scene();
  const camera = new OrthographicCamera(-800, 800, 450, -450, 0.1, 30000);
  camera.position.set(0, 0, 10000);
  camera.lookAt(0, 0, 0);
  const globe = new Group();
  scene.add(globe);

  scene.add(new AmbientLight('#ffffff', 2.55));
  const light = new DirectionalLight('#ffffff', 0.48);
  light.position.set(-0.65, 0.8, 1.4);
  scene.add(light);

  const geometry = makeSphereGrid();
  const morphUniforms = {
    uMorph: { value: 0 },
    uGlobeRotation: { value: new Matrix4() },
    uGlobeRadius: { value: 360 },
    uFlatCamera: { value: new Vector2() },
    uFlatScale: { value: 1 },
    uGlobeCenter: { value: new Vector2(800, 450) },
  };
  let texture: Texture | null = null;
  let surface: Mesh | null = null;
  let surfaceMaterial: MeshPhongMaterial | null = null;
  let atmosphere: Mesh | null = null;
  let disposed = false;
  let contextLost = false;
  let previousWidth = -1;
  let previousHeight = -1;
  let previousPixelRatio = -1;

  const atmosphereMaterial = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    uniforms: { uOpacity: { value: 0 } },
    vertexShader: `varying vec3 vNormal; varying vec3 vView; void main(){ vec4 mv=modelViewMatrix*vec4(position,1.0); vNormal=normalize(normalMatrix*normal); vView=normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }`,
    fragmentShader: `uniform float uOpacity; varying vec3 vNormal; varying vec3 vView; void main(){ float rim=pow(1.0-abs(dot(normalize(vNormal),normalize(vView))),3.0); gl_FragColor=vec4(0.62,0.72,0.70,rim*uOpacity); }`,
  });

  const onContextLost = (event: Event) => {
    event.preventDefault();
    contextLost = true;
    canvas.dataset.unavailable = 'true';
  };
  const onContextRestored = () => {
    contextLost = false;
    texture?.dispose();
    texture = null;
    delete canvas.dataset.unavailable;
    previousWidth = -1;
    previousHeight = -1;
    previousPixelRatio = -1;
  };
  canvas.addEventListener('webglcontextlost', onContextLost, false);
  canvas.addEventListener('webglcontextrestored', onContextRestored, false);

  function render(frame: GlobeFrame): void {
    if (disposed || contextLost || frame.width <= 0 || frame.height <= 0 || !Number.isFinite(frame.radius)) return;
    const fitScale = Math.min(frame.width / 1600, frame.height / 900);
    if (fitScale <= 0) return;
    const worldWidth = frame.width / fitScale;
    const worldHeight = frame.height / fitScale;
    camera.left = -worldWidth / 2;
    camera.right = worldWidth / 2;
    camera.top = worldHeight / 2;
    camera.bottom = -worldHeight / 2;
    camera.updateProjectionMatrix();
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    if (pixelRatio !== previousPixelRatio) {
      renderer.setPixelRatio(pixelRatio);
      previousPixelRatio = pixelRatio;
    }
    if (frame.width !== previousWidth || frame.height !== previousHeight) {
      renderer.setSize(frame.width, frame.height, false);
      previousWidth = frame.width;
      previousHeight = frame.height;
    }

    if (!texture) {
      const nextTexture = makeMapTexture(world);
      if (nextTexture) {
        texture = nextTexture;
        const material = new MeshPhongMaterial({ map: texture, shininess: 8, specular: new Color('#171b19'), side: DoubleSide });
        material.onBeforeCompile = shader => {
          Object.assign(shader.uniforms, morphUniforms);
          shader.vertexShader = shader.vertexShader.replace(
            '#include <common>',
            `#include <common>\nattribute vec2 flatLocation;\nuniform float uMorph;\nuniform mat4 uGlobeRotation;\nuniform float uGlobeRadius;\nuniform vec2 uFlatCamera;\nuniform float uFlatScale;\nuniform vec2 uGlobeCenter;`,
          );
          shader.vertexShader = shader.vertexShader.replace(
            '#include <beginnormal_vertex>',
            `vec3 objectNormal = mix(vec3(0.0, 0.0, 1.0), (uGlobeRotation * vec4(normal, 0.0)).xyz, uMorph) + vec3(0.0, 0.0, 0.00001);\n#ifdef USE_TANGENT\n vec3 objectTangent = vec3(tangent.xyz);\n#endif`,
          );
          shader.vertexShader = shader.vertexShader.replace(
            '#include <begin_vertex>',
            `vec3 flatWorld = vec3(flatLocation.x * uFlatScale + uFlatCamera.x - 800.0, 450.0 - (flatLocation.y * uFlatScale + uFlatCamera.y), 0.0);\nvec3 sphereWorld = (uGlobeRotation * vec4(position * uGlobeRadius, 0.0)).xyz + vec3(uGlobeCenter.x - 800.0, 450.0 - uGlobeCenter.y, 0.0);\nvec3 transformed = mix(flatWorld, sphereWorld, uMorph);`,
          );
        };
        material.customProgramCacheKey = () => 'atlas-globe-morph-v1';
        if (surface) {
          surface.material = material;
          surfaceMaterial?.dispose();
        } else {
          surface = new Mesh(geometry, material);
          surface.renderOrder = 1;
          globe.add(surface);
        }
        surfaceMaterial = material;
      }
    }
    const radius = Math.max(1, frame.radius);
    morphUniforms.uMorph.value = Math.max(0, Math.min(1, frame.morph));
    morphUniforms.uGlobeRotation.value.copy(rotationMatrix(frame.longitude, frame.latitude));
    morphUniforms.uGlobeRadius.value = radius;
    morphUniforms.uFlatCamera.value.set(frame.flatCamera.x, frame.flatCamera.y);
    morphUniforms.uFlatScale.value = frame.flatCamera.k;
    morphUniforms.uGlobeCenter.value.set(frame.center[0], frame.center[1]);
    if (surface) {
      surface.scale.setScalar(1);
      surface.position.set(0, 0, 0);
      surface.rotation.set(0, 0, 0);
    }
    if (!atmosphere) {
      atmosphere = new Mesh(new SphereGeometry(1.012, 96, 64), atmosphereMaterial);
      atmosphere.renderOrder = 2;
      globe.add(atmosphere);
    }
    atmosphere.scale.setScalar(radius);
    atmosphere.position.set(frame.center[0] - 800, 450 - frame.center[1], 0);
    atmosphere.setRotationFromMatrix(rotationMatrix(frame.longitude, frame.latitude));
    const atmosphereProgress = Math.max(0, Math.min(1, (frame.morph - 0.8) / 0.2));
    atmosphereMaterial.uniforms.uOpacity.value = atmosphereProgress * atmosphereProgress * (3 - 2 * atmosphereProgress) * 0.17;
    atmosphere.visible = frame.morph > 0.8;
    renderer.render(scene, camera);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    canvas.removeEventListener('webglcontextlost', onContextLost);
    canvas.removeEventListener('webglcontextrestored', onContextRestored);
    geometry.dispose();
    texture?.dispose();
    surfaceMaterial?.dispose();
    atmosphereMaterial.dispose();
    (atmosphere?.geometry as SphereGeometry | undefined)?.dispose();
    renderer.dispose();
  }

  return { render, dispose };
}
