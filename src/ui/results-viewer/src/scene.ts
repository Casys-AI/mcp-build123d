/// <reference lib="dom" />
/// <reference types="npm:@types/three@0.172.0" />

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

export interface CadSceneController {
  readonly meshes: number;
  readonly nodes: number;
  fit(): void;
  reset(): void;
  setWireframe(enabled: boolean): void;
  dispose(): void;
}

function materialWireframe(material: THREE.Material, enabled: boolean): void {
  if ("wireframe" in material) {
    (material as THREE.MeshStandardMaterial).wireframe = enabled;
    material.needsUpdate = true;
  }
}

function disposeMaterial(material: THREE.Material): void {
  for (const value of Object.values(material)) {
    if (value instanceof THREE.Texture) (value as THREE.Texture).dispose();
  }
  material.dispose();
}

function glbBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

/** Mount a self-contained, offline Three.js inspector for one trusted GLB. */
export async function mountCadScene(
  viewport: HTMLElement,
  bytes: Uint8Array,
): Promise<CadSceneController> {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  viewport.replaceChildren(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color();

  const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 100000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.screenSpacePanning = true;
  controls.zoomToCursor = true;

  scene.add(new THREE.HemisphereLight(0xf5e9dc, 0x211c18, 2.1));
  const key = new THREE.DirectionalLight(0xffffff, 3.2);
  key.position.set(4, 6, 5);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xe49a53, 1.8);
  rim.position.set(-5, 2, -4);
  scene.add(rim);

  const loader = new GLTFLoader();
  let model: THREE.Group;
  try {
    model = await new Promise<THREE.Group>((resolve, reject) => {
      loader.parse(
        glbBuffer(bytes),
        "",
        (gltf: { scene: THREE.Group }) => resolve(gltf.scene),
        reject,
      );
    });
  } catch (error) {
    controls.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    viewport.replaceChildren();
    throw error;
  }
  scene.add(model);

  const bounds = new THREE.Box3().setFromObject(model);
  if (bounds.isEmpty()) {
    controls.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    viewport.replaceChildren();
    throw new Error("The GLB contains no displayable geometry.");
  }
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const radius = Math.max(size.length() * 0.5, 0.001);
  const fog = new THREE.FogExp2(0xffffff, 0.12 / radius);
  scene.fog = fog;

  const gridSize = Math.max(Math.ceil(Math.max(size.x, size.z) * 1.8), 10);
  const gridDivisions = Math.min(Math.max(Math.round(gridSize / 10), 10), 80);
  const grid = new THREE.GridHelper(
    gridSize,
    gridDivisions,
    0xffffff,
    0xffffff,
  );
  grid.position.y = bounds.min.y;
  (grid.material as THREE.Material).opacity = 0.42;
  (grid.material as THREE.Material).transparent = true;
  scene.add(grid);

  // A host theme update changes palette only: the verified model, controls and
  // camera stay mounted. Computed CSS resolves the aliases to the shared kit's
  // tokens before they reach WebGL; the overlay uses the same palette.
  const applyTheme = (): void => {
    const style = getComputedStyle(viewport);
    const background = style.getPropertyValue("--cad-scene-background").trim();
    const gridColor = style.getPropertyValue("--cad-grid").trim();
    if (background) (scene.background as THREE.Color).set(background);
    fog.color.copy(scene.background as THREE.Color);
    if (gridColor) {
      (grid.material as THREE.LineBasicMaterial).color.set(gridColor);
    }
  };
  applyTheme();
  const themeObserver = new MutationObserver(applyTheme);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "class", "style"],
  });
  const preferredTheme = matchMedia("(prefers-color-scheme: dark)");
  preferredTheme.addEventListener("change", applyTheme);

  camera.near = Math.max(radius / 1000, 0.001);
  camera.far = Math.max(radius * 100, 1000);
  camera.updateProjectionMatrix();

  const fitFromDirection = (direction: THREE.Vector3): void => {
    const verticalFov = THREE.MathUtils.degToRad(camera.fov);
    const horizontalFov = 2 * Math.atan(
      Math.tan(verticalFov / 2) * camera.aspect,
    );
    const limitingFov = Math.max(Math.min(verticalFov, horizontalFov), 0.01);
    const distance = radius / Math.sin(limitingFov / 2);
    camera.position.copy(center).add(
      direction.normalize().multiplyScalar(distance * 1.15),
    );
    controls.target.copy(center);
    controls.minDistance = radius * 0.04;
    controls.maxDistance = radius * 30;
    controls.update();
  };
  const fit = (): void => {
    const direction = camera.position.clone().sub(controls.target);
    fitFromDirection(
      direction.lengthSq() > 0 ? direction : new THREE.Vector3(1, 0.8, 1),
    );
  };
  const reset = (): void =>
    fitFromDirection(new THREE.Vector3(1.25, 0.9, 1.25));

  let meshes = 0;
  let nodes = 0;
  let wireframe = false;
  model.traverse((object: THREE.Object3D) => {
    nodes += 1;
    if ((object as THREE.Mesh).isMesh) meshes += 1;
  });

  const setWireframe = (enabled: boolean): void => {
    wireframe = enabled;
    model.traverse((object: THREE.Object3D) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material];
      for (const material of materials) materialWireframe(material, wireframe);
    });
  };

  const resize = (): void => {
    const width = Math.max(viewport.clientWidth, 1);
    const height = Math.max(viewport.clientHeight, 1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(viewport);
  resize();
  reset();

  let disposed = false;
  let frame = 0;
  const animate = (): void => {
    if (disposed) return;
    frame = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  };
  animate();

  return {
    meshes,
    nodes,
    fit,
    reset,
    setWireframe,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      themeObserver.disconnect();
      preferredTheme.removeEventListener("change", applyTheme);
      controls.dispose();
      model.traverse((object: THREE.Object3D) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry?.dispose();
        const materials = Array.isArray(mesh.material)
          ? mesh.material
          : [mesh.material];
        for (const material of materials) disposeMaterial(material);
      });
      grid.geometry.dispose();
      const gridMaterials = Array.isArray(grid.material)
        ? grid.material
        : [grid.material];
      for (const material of gridMaterials) material.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      viewport.replaceChildren();
    },
  };
}
