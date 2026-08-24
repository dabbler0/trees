import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Bud, BranchSegment, Leaf, TreeState } from '../model/types';
import { distance } from '../model/vec3';
import { COLOR_MODES, getColorMode, type ColorModeId } from './colorSchemes';

/**
 * Procedurally draws a single leaf silhouette -- a pointed almond shape
 * with a center vein and a few side veins -- onto a canvas and returns it
 * as a texture. Generated at load time rather than fetched, since this
 * whole app builds to one self-contained HTML file with no external
 * assets. The canvas starts fully transparent and only the leaf shape
 * itself is painted, so the resulting texture's own alpha channel is
 * exactly the leaf's silhouette: used as both the diffuse map (so leaves
 * are actually green, not a green-tinted blob) and, via
 * `material.alphaTest`, as the cutout shape that both the visible render
 * and -- automatically, this is standard three.js shadow-map behavior
 * for any alphaTest material -- the shadow-map depth pass respect. That
 * second part is what makes "photo" mode's leaves cast real leaf-shaped
 * shadows instead of solid rectangular/blob ones.
 */
function makeLeafTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);
  ctx.translate(size / 2, size / 2);

  ctx.beginPath();
  ctx.moveTo(0, -size * 0.47);
  ctx.bezierCurveTo(size * 0.44, -size * 0.28, size * 0.4, size * 0.32, 0, size * 0.47);
  ctx.bezierCurveTo(-size * 0.4, size * 0.32, -size * 0.44, -size * 0.28, 0, -size * 0.47);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, -size * 0.47, 0, size * 0.47);
  grad.addColorStop(0, '#66b34e');
  grad.addColorStop(1, '#3f8a34');
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.save();
  ctx.clip();
  ctx.strokeStyle = 'rgba(35, 75, 25, 0.55)';
  ctx.lineWidth = size * 0.02;
  ctx.beginPath();
  ctx.moveTo(0, -size * 0.45);
  ctx.lineTo(0, size * 0.45);
  ctx.stroke();
  ctx.lineWidth = size * 0.012;
  for (const t of [-0.55, -0.2, 0.2, 0.55]) {
    const y = t * size * 0.42;
    const spread = (0.45 - Math.abs(t) * 0.3) * size * 0.32;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(side * spread, y + size * 0.1);
      ctx.stroke();
    }
  }
  ctx.restore();

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export { COLOR_MODES };
export type { ColorModeId };

export interface DebugRendererOptions {
  /** Render segments at their true tapered radius, vs. a uniform thin skeleton line. */
  showThickness: boolean;
  /** Render the leaf point cloud. */
  showLeaves: boolean;
  colorMode: ColorModeId;
}

const DEFAULT_OPTIONS: DebugRendererOptions = {
  showThickness: true,
  showLeaves: true,
  colorMode: 'natural',
};

/** What gets handed to a hover callback -- deliberately carries the full
 * underlying data object, not a pre-formatted string, so the host page
 * can render whatever tooltip/inspector it wants (this is the "easy to
 * add debug info on hover" extension point). */
export type HoverInfo =
  | { kind: 'segment'; segment: BranchSegment; tipBud: Bud | undefined }
  | { kind: 'leaf'; leaf: Leaf };

const SKELETON_RADIUS = 0.015; // meters, uniform line-like thickness when showThickness=false
const UNIT_CYLINDER_SEGMENTS = 7; // low-poly: this can be rendered thousands of times over

/**
 * A three.js debug renderer for a single TreeState snapshot. Deliberately
 * has zero knowledge of the simulation engine -- it only ever consumes
 * the plain TreeState/SimulationHistory data types, so it can equally
 * render a freshly-simulated tree or one re-loaded from a saved history
 * file.
 *
 * Rendering strategy: branch segments and leaves are each drawn with a
 * single THREE.InstancedMesh (one shared low-poly cylinder / sphere
 * geometry, one instance transform + color per segment/leaf). This keeps
 * tens of thousands of segments well within one draw call each. A true
 * per-segment taper (different radius at each end) isn't representable
 * with a single instanced geometry, so "thickness" mode uses each
 * segment's mean radius -- a reasonable approximation given how short
 * individual annual internodes are.
 */
export class TreeDebugRenderer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;

  private branchGeometry = new THREE.CylinderGeometry(1, 1, 1, UNIT_CYLINDER_SEGMENTS, 1);
  private leafGeometry = new THREE.SphereGeometry(1, 6, 5);
  private branchMaterial = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.0 });
  private leafMaterial = new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.0 });

  /** "Photo" mode's leaves: a textured, alpha-cutout plane instead of a
   * sphere -- see makeLeafTexture. alphaTest (rather than blending) is
   * what makes this cutout shape show up automatically in the shadow-map
   * depth pass too, which is what gives real leaf-shaped shadows instead
   * of solid disc/blob ones. */
  private leafTexture = makeLeafTexture();
  private leafPhotoGeometry = new THREE.PlaneGeometry(1, 1);
  private leafPhotoMaterial = new THREE.MeshStandardMaterial({
    map: this.leafTexture,
    alphaTest: 0.4,
    side: THREE.DoubleSide,
    roughness: 0.85,
    metalness: 0.0,
  });

  private branchMesh: THREE.InstancedMesh | null = null;
  private leafMesh: THREE.InstancedMesh | null = null;
  /** Parallel arrays: instance index -> underlying id, for hover lookups. */
  private branchIndexToSegmentId: number[] = [];
  private leafIndexToLeafId: number[] = [];

  private options: DebugRendererOptions = { ...DEFAULT_OPTIONS };
  private currentState: TreeState | null = null;

  private raycaster = new THREE.Raycaster();
  private pointerNdc = new THREE.Vector2();

  private sunLight: THREE.DirectionalLight;
  private sunTarget = new THREE.Object3D();
  private ground: THREE.Mesh;
  /** Tracks the tree's approximate size (set by frame()) so the sun's
   * shadow camera frustum can be sized to just cover it -- an
   * orthographic shadow camera sized for the whole scene would waste
   * almost all of its depth-buffer resolution on empty space. */
  private boundingRadius = 8;
  private centerHeight = 4;
  /** Unit vector from the tree toward the sun -- same convention as
   * sim/sun.ts's sunDirection(). Persisted so resizing the shadow camera
   * to a newly-loaded tree's size doesn't need to round-trip through the
   * light's current world position to recover it. */
  private sunDir = new THREE.Vector3(0.35, 0.85, 0.26).normalize();

  /** Set this to receive hover updates; called with null when nothing is under the pointer. */
  onHover: ((info: HoverInfo | null) => void) | null = null;

  constructor(private container: HTMLElement) {
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 2000);
    this.camera.position.set(12, 10, 16);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    // Always on: with nothing set to castShadow this costs essentially
    // nothing, and it means switching into "photo" mode is just a matter
    // of flipping castShadow/receiveShadow on the relevant objects rather
    // than reinitializing the renderer.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 3, 0);
    this.controls.enableDamping = false;
    this.controls.addEventListener('change', () => this.render());

    this.scene.background = new THREE.Color('#cfe8f5');
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#3a2f1f', 1.1));
    this.sunLight = new THREE.DirectionalLight('#fff6e0', 1.4);
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.bias = -0.0015;
    this.sunLight.shadow.normalBias = 0.02;
    this.scene.add(this.sunLight);
    this.scene.add(this.sunTarget);
    this.sunLight.target = this.sunTarget;

    this.ground = new THREE.Mesh(
      new THREE.CircleGeometry(60, 48),
      // Semi-transparent, and depthWrite:false, so the below-ground root
      // system actually renders through it (a literal opaque disc would
      // otherwise fully occlude every root, and even a naively-transparent
      // one would still write depth and z-fight/hide what's behind it) --
      // reads as a soil tint over the roots rather than a true cutaway,
      // which is enough to see the root system's shape without a much
      // more involved clip-plane/cutaway renderer.
      new THREE.MeshStandardMaterial({ color: '#6f8f5c', roughness: 1, transparent: true, opacity: 0.55, depthWrite: false })
    );
    this.ground.renderOrder = 1; // draw after roots so its transparency blends over them, not the reverse
    this.ground.rotation.x = -Math.PI / 2;
    this.scene.add(this.ground);
    const grid = new THREE.GridHelper(60, 60, '#3f5a35', '#557a48');
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.35;
    this.scene.add(grid);

    this.renderer.domElement.addEventListener('pointermove', this.handlePointerMove);
    this.renderer.domElement.addEventListener('pointerleave', () => this.onHover?.(null));

    this.updateShadowCamera();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /** Point the camera at a tree of the given approximate size. Called
   * once when a whole new simulation is loaded (not on every scrub
   * frame, so it never fights the user's own camera control). */
  frame(height: number, crownWidth: number): void {
    const centerHeight = height / 2;
    const boundingRadius = Math.max(1.5, height / 2, crownWidth / 2) * 1.15;
    this.centerHeight = centerHeight;
    this.boundingRadius = boundingRadius;
    const fovRad = (this.camera.fov * Math.PI) / 180;
    const distance = boundingRadius / Math.sin(fovRad / 2);
    this.controls.target.set(0, centerHeight, 0);
    const dir = new THREE.Vector3(0.55, 0.4, 0.75).normalize();
    this.camera.position.copy(dir.multiplyScalar(distance)).add(new THREE.Vector3(0, centerHeight, 0));
    this.camera.near = Math.max(0.05, distance / 200);
    this.camera.far = distance * 10 + boundingRadius;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.updateShadowCamera();
  }

  /**
   * Points the "sun" directional light along the given direction (unit
   * vector, pointing *from the tree toward the sun* -- the same
   * convention as sim/sun.ts's sunDirection()) so "photo" mode's
   * lighting/shadows actually match whatever sun angle the tree was
   * simulated under, instead of a fixed studio-light position. Safe to
   * call at any time; has no visible effect until something has
   * castShadow/receiveShadow enabled (i.e. photo mode).
   */
  setSunDirection(dir: readonly [number, number, number]): void {
    const v = new THREE.Vector3(dir[0], dir[1], dir[2]);
    if (v.lengthSq() < 1e-9) return;
    this.sunDir.copy(v).normalize();
    this.repositionSun();
    this.render();
  }

  /** Sizes the sun's orthographic shadow camera to just cover the
   * current tree, so its depth-buffer resolution isn't wasted on empty
   * space far from the canopy. */
  private updateShadowCamera(): void {
    const cam = this.sunLight.shadow.camera;
    const half = this.boundingRadius * 1.1;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.near = 0.5;
    cam.far = this.boundingRadius * 4 + 40;
    cam.updateProjectionMatrix();
    this.repositionSun();
  }

  private repositionSun(): void {
    const distance = this.boundingRadius * 4 + 20;
    const center = new THREE.Vector3(0, this.centerHeight, 0);
    this.sunLight.position.copy(this.sunDir).multiplyScalar(distance).add(center);
    this.sunTarget.position.copy(center);
    this.sunLight.target.updateMatrixWorld();
  }

  resize(): void {
    const { clientWidth, clientHeight } = this.container;
    if (clientWidth === 0 || clientHeight === 0) return;
    this.camera.aspect = clientWidth / clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(clientWidth, clientHeight);
    this.render();
  }

  setOptions(partial: Partial<DebugRendererOptions>): void {
    this.options = { ...this.options, ...partial };
    if (this.currentState) this.rebuild(this.currentState);
    this.render();
  }

  getOptions(): DebugRendererOptions {
    return { ...this.options };
  }

  setState(state: TreeState): void {
    this.currentState = state;
    this.rebuild(state);
    this.render();
  }

  private disposeMesh(mesh: THREE.InstancedMesh | null): void {
    if (mesh) this.scene.remove(mesh);
  }

  private rebuild(state: TreeState): void {
    this.disposeMesh(this.branchMesh);
    this.disposeMesh(this.leafMesh);

    const tipBudBySegmentId = new Map<number, Bud>();
    for (const bud of state.buds) {
      if (bud.status !== 'dead') tipBudBySegmentId.set(bud.segmentId, bud);
    }
    const maxHydraulicResistance = state.segments.reduce((m, s) => Math.max(m, s.hydraulicResistance), 0);
    const colorMode = getColorMode(this.options.colorMode);
    const isPhoto = this.options.colorMode === 'photo';

    // "Photo" mode is the only one that pays for real-time shadows: with
    // nothing set to cast/receive, the always-on shadow map (see
    // constructor) does essentially no work, so every other mode stays
    // exactly as fast as before.
    this.sunLight.castShadow = isPhoto;
    this.ground.receiveShadow = isPhoto;

    // --- Branch skeleton / thickness ---
    const segments = state.segments;
    const branchMesh = new THREE.InstancedMesh(this.branchGeometry, this.branchMaterial, Math.max(1, segments.length));
    branchMesh.count = segments.length;
    branchMesh.castShadow = isPhoto;
    branchMesh.receiveShadow = isPhoto;
    this.branchIndexToSegmentId = new Array(segments.length);

    const m = new THREE.Matrix4();
    const up = new THREE.Vector3(0, 1, 0);
    const forward = new THREE.Vector3(0, 0, 1);
    const dir = new THREE.Vector3();
    const mid = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scaleVec = new THREE.Vector3();
    const startV = new THREE.Vector3();
    const endV = new THREE.Vector3();

    segments.forEach((s, i) => {
      startV.set(s.start[0], s.start[1], s.start[2]);
      endV.set(s.end[0], s.end[1], s.end[2]);
      const len = Math.max(0.001, distance(s.start, s.end));
      dir.subVectors(endV, startV).normalize();
      quat.setFromUnitVectors(up, dir);
      mid.addVectors(startV, endV).multiplyScalar(0.5);
      const radius = this.options.showThickness ? Math.max((s.baseRadius + s.tipRadius) / 2, 0.003) : SKELETON_RADIUS;
      scaleVec.set(radius, len, radius);
      m.compose(mid, quat, scaleVec);
      branchMesh.setMatrixAt(i, m);
      branchMesh.setColorAt(i, colorMode.color({ segment: s, tipBud: tipBudBySegmentId.get(s.id), currentYear: state.year, maxHydraulicResistance }));
      this.branchIndexToSegmentId[i] = s.id;
    });
    branchMesh.instanceMatrix.needsUpdate = true;
    if (branchMesh.instanceColor) branchMesh.instanceColor.needsUpdate = true;
    this.scene.add(branchMesh);
    this.branchMesh = branchMesh;

    // --- Leaves ---
    if (this.options.showLeaves && state.leaves.length > 0) {
      const leaves = state.leaves;
      const geometry = isPhoto ? this.leafPhotoGeometry : this.leafGeometry;
      const material = isPhoto ? this.leafPhotoMaterial : this.leafMaterial;
      const leafMesh = new THREE.InstancedMesh(geometry, material, leaves.length);
      leafMesh.count = leaves.length;
      leafMesh.castShadow = isPhoto;
      leafMesh.receiveShadow = isPhoto;
      this.leafIndexToLeafId = new Array(leaves.length);
      const leafColor = new THREE.Color('#4a8c3f');
      const tint = new THREE.Color();
      leaves.forEach((leaf, i) => {
        if (isPhoto) {
          // A flat, roughly leaf-area-sized square plane, oriented along
          // this leaf's own (already-jittered, per-leaf) normal rather
          // than billboarded toward the camera -- avoids a per-frame
          // update on every instance, and a real canopy's leaves really
          // do face many different directions at once.
          const side = Math.max(0.05, Math.sqrt(leaf.area) * 1.6);
          dir.set(leaf.normal[0], leaf.normal[1], leaf.normal[2]).normalize();
          quat.setFromUnitVectors(forward, dir);
          scaleVec.set(side, side, side);
          mid.set(leaf.position[0], leaf.position[1], leaf.position[2]);
          m.compose(mid, quat, scaleVec);
          // Subtle per-leaf color variation (deterministic from id) so a
          // dense canopy doesn't read as one flat-shaded texture repeated
          // thousands of times.
          const jitter = ((leaf.id * 2654435761) >>> 0) / 0xffffffff;
          tint.setHSL(0.30 + jitter * 0.06, 0.5 + jitter * 0.15, 0.42 + jitter * 0.16);
          leafMesh.setColorAt(i, tint);
        } else {
          const r = Math.max(0.015, Math.sqrt(leaf.area / Math.PI));
          m.makeScale(r, r, r);
          m.setPosition(leaf.position[0], leaf.position[1], leaf.position[2]);
          leafMesh.setColorAt(i, leafColor);
        }
        leafMesh.setMatrixAt(i, m);
        this.leafIndexToLeafId[i] = leaf.id;
      });
      leafMesh.instanceMatrix.needsUpdate = true;
      if (leafMesh.instanceColor) leafMesh.instanceColor.needsUpdate = true;
      this.scene.add(leafMesh);
      this.leafMesh = leafMesh;
    } else {
      this.leafMesh = null;
      this.leafIndexToLeafId = [];
    }
  }

  private handlePointerMove = (event: PointerEvent): void => {
    if (!this.onHover) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    const info = this.pick();
    this.onHover(info);
  };

  private pick(): HoverInfo | null {
    if (!this.currentState) return null;
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const targets = [this.branchMesh, this.leafMesh].filter((x): x is THREE.InstancedMesh => x !== null);
    const hits = this.raycaster.intersectObjects(targets, false);
    if (hits.length === 0) return null;
    const hit = hits[0];
    if (hit.instanceId === undefined) return null;
    if (hit.object === this.branchMesh) {
      const segId = this.branchIndexToSegmentId[hit.instanceId];
      const segment = this.currentState.segments.find((s) => s.id === segId);
      if (!segment) return null;
      const tipBud = this.currentState.buds.find((b) => b.segmentId === segId && b.status !== 'dead');
      return { kind: 'segment', segment, tipBud };
    }
    if (hit.object === this.leafMesh) {
      const leafId = this.leafIndexToLeafId[hit.instanceId];
      const leaf = this.currentState.leaves.find((l) => l.id === leafId);
      if (!leaf) return null;
      return { kind: 'leaf', leaf };
    }
    return null;
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.renderer.dispose();
    this.branchGeometry.dispose();
    this.leafGeometry.dispose();
    this.branchMaterial.dispose();
    this.leafMaterial.dispose();
    this.leafPhotoGeometry.dispose();
    this.leafPhotoMaterial.dispose();
    this.leafTexture.dispose();
  }
}
