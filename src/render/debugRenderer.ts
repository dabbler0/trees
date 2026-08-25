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

/**
 * Procedurally draws a tileable dirt/soil texture -- mottled earthy
 * patches plus sparse small pebble flecks -- for walking mode's ground
 * (see TreeDebugRenderer.enterWalkMode), the same load-time-canvas
 * approach as makeLeafTexture above rather than an external image asset.
 * Built lazily (only the first time walking mode is entered) since a
 * session that never walks shouldn't pay for it.
 */
function makeDirtTexture(): THREE.Texture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#6b4a30';
  ctx.fillRect(0, 0, size, size);

  // Mottled patches, both darker (damp/shadowed clumps) and lighter
  // (drier/sun-bleached patches), scattered at random -- what actually
  // reads as "dirt" rather than a flat color once tiled.
  for (let i = 0; i < 900; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 2 + Math.random() * 9;
    const darker = Math.random() < 0.55;
    const shade = Math.random();
    ctx.fillStyle = darker
      ? `rgba(${40 + shade * 25}, ${28 + shade * 18}, ${16 + shade * 10}, ${0.12 + Math.random() * 0.22})`
      : `rgba(${120 + shade * 40}, ${90 + shade * 30}, ${58 + shade * 22}, ${0.1 + Math.random() * 0.18})`;
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * (0.55 + Math.random() * 0.6), Math.random() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  // Sparse small pebbles/grit -- desaturated gray flecks, much smaller
  // and sparser than the soil mottling above.
  for (let i = 0; i < 140; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 1 + Math.random() * 2.2;
    ctx.fillStyle = `rgba(95, 88, 80, ${0.3 + Math.random() * 0.3})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
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
 * add debug info on hover" extension point). `treeId` is always 0 for a
 * lone tree loaded via setState (see RenderTree's own doc) -- a forest
 * host page can use it to tell which tree was hovered. */
export type HoverInfo =
  | { kind: 'segment'; treeId: number; segment: BranchSegment; tipBud: Bud | undefined }
  | { kind: 'leaf'; treeId: number; leaf: Leaf };

/** One tree's own state plus where it sits in the shared world (its own
 * local segment coordinates stay untouched, base at the origin -- this
 * offset is applied only at render time, the same convention
 * stepYear/light.ts's forest support uses). A lone tree rendered via
 * setState is just a single-entry array with offset (0, 0) and id 0. */
export interface RenderTree {
  id: number;
  offset: readonly [number, number];
  state: TreeState;
}

const SKELETON_RADIUS = 0.015; // meters, uniform line-like thickness when showThickness=false
const UNIT_CYLINDER_SEGMENTS = 7; // low-poly: this can be rendered thousands of times over

/** Ground plane side length, meters -- generous enough that walking mode
 * (see enterWalkMode) has real room to roam before running out of
 * modeled terrain, and the dirt texture's repeat count below is chosen
 * to match. */
const GROUND_SIZE = 300;
/** Dirt texture tile size on the ground, meters -- how large one repeat
 * of makeDirtTexture's pattern reads as once tiled. */
const DIRT_TILE_SIZE = 3;

/** Eye height above the (flat) ground while walking, meters -- an average
 * adult standing eye height. Every distance in this simulation (tree
 * height, DBH, root spread, ...) is already real meters, so this reads
 * directly to-scale against a grown tree with no separate scale factor
 * needed: a person this tall standing next to, say, a 15m mature crown is
 * exactly as small a fraction of it as a real person would be. */
const WALK_EYE_HEIGHT = 1.7;
/** How close the near clip plane sits to the eye while walking, meters --
 * deliberately much closer than the orbit camera's own near plane (which
 * is sized to whatever the *whole scene* being framed measures, often
 * several meters for a large forest, and would clip the ground and any
 * nearby trunk at ordinary walking distances). */
const WALK_NEAR_CLIP = 0.05;
/** Walking speed, meters/second. */
const WALK_MOVE_SPEED = 4.5;
/** Mouse-look sensitivity, radians of yaw/pitch per pixel of mouse movement. */
const WALK_MOUSE_SENSITIVITY = 0.0022;
/** How close to straight up/down mouse-look pitch is allowed to get,
 * radians short of vertical -- never quite lets the horizon flip. */
const WALK_PITCH_LIMIT = Math.PI / 2 - 0.05;
/** Physical keys walking mode tracks; anything else passes through to the
 * page normally (so, e.g., a stray keypress doesn't get swallowed). */
const WALK_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD']);

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
  /** Parallel arrays: instance index -> underlying (treeId, id), for hover
   * lookups. A lone tree (setState) always has treeId 0 throughout. */
  private branchIndexToTreeId: number[] = [];
  private branchIndexToSegmentId: number[] = [];
  private leafIndexToTreeId: number[] = [];
  private leafIndexToLeafId: number[] = [];

  private options: DebugRendererOptions = { ...DEFAULT_OPTIONS };
  private currentTrees: RenderTree[] = [];

  private raycaster = new THREE.Raycaster();
  private pointerNdc = new THREE.Vector2();

  private sunLight: THREE.DirectionalLight;
  private sunTarget = new THREE.Object3D();
  private ground: THREE.Mesh;
  private grid: THREE.GridHelper;
  /** The everyday translucent-green, root-revealing ground material (see
   * its own doc at construction) vs. walking mode's opaque dirt one --
   * swapped on the same `ground` mesh rather than rebuilding it, since
   * neither the geometry nor its position/rotation ever differ. */
  private groundMaterialNormal: THREE.MeshStandardMaterial;
  /** Built lazily on first entering walking mode (see makeDirtTexture) --
   * a session that never walks shouldn't pay for the canvas work. */
  private groundMaterialDirt: THREE.MeshStandardMaterial | null = null;
  /** Tracks the current scene's approximate size/center (set by frame()/
   * frameForest()) so the sun's shadow camera frustum can be sized to
   * just cover it -- an orthographic shadow camera sized for the whole
   * scene would waste almost all of its depth-buffer resolution on empty
   * space -- and so the sun can be repositioned relative to wherever the
   * scene is actually centered (a lone tree at the origin, or a whole
   * forest's own bounding center, which need not be the origin). */
  private boundingRadius = 8;
  private sceneCenter = new THREE.Vector3(0, 4, 0);
  /** Unit vector from the tree toward the sun -- same convention as
   * sim/sun.ts's sunDirection(). Persisted so resizing the shadow camera
   * to a newly-loaded tree's size doesn't need to round-trip through the
   * light's current world position to recover it. */
  private sunDir = new THREE.Vector3(0.35, 0.85, 0.26).normalize();

  /** Set this to receive hover updates; called with null when nothing is under the pointer. */
  onHover: ((info: HoverInfo | null) => void) | null = null;
  /** Called whenever walking mode starts or stops -- including an exit
   * the host page didn't itself trigger (pressing Escape releases pointer
   * lock, which this renderer treats as "leave walking mode"; see the
   * pointerlockchange listener in the constructor) -- so a host UI can
   * keep its own panels/overlay in sync regardless of how it ended. */
  onWalkModeChange: ((active: boolean) => void) | null = null;
  /** Called when the GPU context is forcibly reclaimed (see the
   * `webglcontextlost` listener in the constructor) and again once it's
   * been restored -- a host UI can use these to show/clear a "recovering"
   * message. Rendering itself pauses and resumes automatically either
   * way; these are purely for user-facing feedback. */
  onContextLost: (() => void) | null = null;
  onContextRestored: (() => void) | null = null;

  private walkActive = false;
  private walkAnimationFrame: number | null = null;
  private walkKeysDown = new Set<string>();
  private walkYaw = 0;
  private walkPitch = 0;
  private walkPosition = new THREE.Vector3(0, WALK_EYE_HEIGHT, 0);
  private walkLastTime = 0;
  /** Snapshot to restore on exit: the orbit camera pose/clip planes and
   * color mode walking mode temporarily overrides. */
  private preWalk: {
    colorMode: ColorModeId;
    cameraPosition: THREE.Vector3;
    controlsTarget: THREE.Vector3;
    near: number;
    far: number;
  } | null = null;

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

    // Semi-transparent, and depthWrite:false, so the below-ground root
    // system actually renders through it (a literal opaque disc would
    // otherwise fully occlude every root, and even a naively-transparent
    // one would still write depth and z-fight/hide what's behind it) --
    // reads as a soil tint over the roots rather than a true cutaway,
    // which is enough to see the root system's shape without a much
    // more involved clip-plane/cutaway renderer. Walking mode (see
    // enterWalkMode) swaps this for an opaque dirt-textured material --
    // there's no root system to reveal from ground level, and real dirt
    // has no reason to be see-through.
    this.groundMaterialNormal = new THREE.MeshStandardMaterial({
      color: '#6f8f5c',
      roughness: 1,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE), this.groundMaterialNormal);
    this.ground.renderOrder = 1; // draw after roots so its transparency blends over them, not the reverse
    this.ground.rotation.x = -Math.PI / 2;
    this.scene.add(this.ground);
    this.grid = new THREE.GridHelper(GROUND_SIZE, GROUND_SIZE / 3, '#3f5a35', '#557a48');
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.35;
    this.scene.add(this.grid);

    this.renderer.domElement.addEventListener('pointermove', this.handlePointerMove);
    this.renderer.domElement.addEventListener('pointerleave', () => this.onHover?.(null));
    // Escape (or any other browser-driven pointer-unlock) always means
    // "leave walking mode" -- see onWalkModeChange's own doc for why this
    // listener, not the explicit exitWalkMode() call site, is the one
    // source of truth for "walking mode just ended".
    document.addEventListener('pointerlockchange', () => {
      if (this.walkActive && document.pointerLockElement !== this.renderer.domElement) this.exitWalkMode();
    });

    // A "WebGL context lost" event is the browser/GPU driver forcibly
    // reclaiming this context, most commonly because too much GPU memory
    // has been allocated (disposeMesh's own doc explains the leak this
    // app used to have) or the OS/driver is under memory pressure and
    // decided this context was the one to sacrifice. calling
    // preventDefault() here is required -- without it the browser treats
    // the loss as permanent and never fires 'webglcontextrestored' at
    // all, leaving the canvas a dead black rectangle forever instead of
    // recovering.
    this.renderer.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      if (this.walkAnimationFrame !== null) {
        cancelAnimationFrame(this.walkAnimationFrame);
        this.walkAnimationFrame = null;
      }
      this.onContextLost?.();
    });
    this.renderer.domElement.addEventListener('webglcontextrestored', () => {
      // three.js re-creates the underlying GL objects for geometries/
      // materials on their next use automatically, but a texture's own
      // pixel data isn't retained GPU-side across a context loss and
      // needs an explicit needsUpdate to actually get re-uploaded to the
      // new context.
      this.leafTexture.needsUpdate = true;
      if (this.groundMaterialDirt?.map) this.groundMaterialDirt.map.needsUpdate = true;
      if (this.currentTrees.length > 0) this.rebuild(this.currentTrees);
      if (this.walkActive) {
        this.walkLastTime = 0;
        this.walkAnimationFrame = requestAnimationFrame(this.walkTick);
      }
      this.render();
      this.onContextRestored?.();
    });

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
    this.applyFraming(new THREE.Vector3(0, centerHeight, 0), boundingRadius);
  }

  /** The multi-tree analogue of frame(): fits the camera to a whole
   * forest's bounding footprint (every living tree's own crown extent,
   * offset by its planting position) rather than one tree centered at
   * the origin. */
  frameForest(trees: readonly { offset: readonly [number, number]; height: number; crownWidth: number }[]): void {
    if (trees.length === 0) {
      this.frame(10, 6);
      return;
    }
    let maxHeight = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const t of trees) {
      maxHeight = Math.max(maxHeight, t.height);
      const r = Math.max(0.5, t.crownWidth / 2);
      minX = Math.min(minX, t.offset[0] - r);
      maxX = Math.max(maxX, t.offset[0] + r);
      minZ = Math.min(minZ, t.offset[1] - r);
      maxZ = Math.max(maxZ, t.offset[1] + r);
    }
    const centerX = (minX + maxX) / 2;
    const centerZ = (minZ + maxZ) / 2;
    const footprintSpread = Math.max(maxX - minX, maxZ - minZ);
    const centerHeight = maxHeight / 2;
    const boundingRadius = Math.max(1.5, maxHeight / 2, footprintSpread / 2) * 1.15;
    this.applyFraming(new THREE.Vector3(centerX, centerHeight, centerZ), boundingRadius);
  }

  private applyFraming(center: THREE.Vector3, boundingRadius: number): void {
    this.sceneCenter.copy(center);
    this.boundingRadius = boundingRadius;
    const fovRad = (this.camera.fov * Math.PI) / 180;
    const distance = boundingRadius / Math.sin(fovRad / 2);
    this.controls.target.copy(center);
    const dir = new THREE.Vector3(0.55, 0.4, 0.75).normalize();
    this.camera.position.copy(dir.multiplyScalar(distance)).add(center);
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
    this.sunLight.position.copy(this.sunDir).multiplyScalar(distance).add(this.sceneCenter);
    this.sunTarget.position.copy(this.sceneCenter);
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

  isWalking(): boolean {
    return this.walkActive;
  }

  /**
   * Enters an immersive first-person "walking simulator" view: orbit
   * controls are disabled in favor of WASD + mouse-look, foliage/shadows
   * switch to "photo" mode (real leaf-shaped shadows read far better up
   * close than the debug point-cloud/skeleton modes), and the ground
   * swaps from the analytic translucent-green disc to an opaque dirt
   * texture (there's no root system to reveal from ground level, and a
   * see-through ground would look wrong up close).
   *
   * Controls: W/S walk forward/backward, A/D strafe left/right, all
   * relative to the current look direction (a standard six-directional
   * FPS scheme); mouse movement (once pointer-locked, which this requests
   * immediately -- must be called from a user-gesture handler, e.g. a
   * button's click listener, for the browser to grant it) looks around
   * freely in both yaw and pitch -- turning is mouse-only, keyboard never
   * rotates the view. Movement stays on the flat ground plane at a fixed
   * eye height (WALK_EYE_HEIGHT -- a real average adult standing height,
   * directly to scale against a grown tree since every distance in this
   * simulation is already real meters); there's no collision detection
   * against trees or terrain relief (the ground is flat), so walking
   * through a trunk is possible -- an acceptable simplification for a
   * debug/showcase view rather than a game.
   *
   * Exits via exitWalkMode() (an explicit "Exit walking mode" button, at
   * the host page's discretion) or automatically the moment pointer lock
   * is released for any other reason (most commonly the user pressing
   * Escape, which the browser itself intercepts to release pointer lock
   * before this code ever sees the keystroke -- see the
   * `pointerlockchange` listener in the constructor).
   */
  enterWalkMode(): void {
    if (this.walkActive) return;
    this.walkActive = true;

    this.preWalk = {
      colorMode: this.options.colorMode,
      cameraPosition: this.camera.position.clone(),
      controlsTarget: this.controls.target.clone(),
      near: this.camera.near,
      far: this.camera.far,
    };
    this.controls.enabled = false;
    this.setOptions({ colorMode: 'photo' });

    // The orbit camera's near/far planes are sized to whatever the whole
    // *scene* being framed measures (see applyFraming) -- for a large
    // forest that can mean a near plane a meter or more out, which would
    // clip the ground and any nearby trunk at ordinary walking distances.
    // A fixed, close-up pair is what actually keeps things looking
    // correctly to-scale once the camera is down at human eye height.
    this.camera.near = WALK_NEAR_CLIP;
    this.camera.far = Math.max(this.camera.far, GROUND_SIZE * 2);
    this.camera.updateProjectionMatrix();

    if (!this.groundMaterialDirt) {
      const dirtTexture = makeDirtTexture();
      const repeats = GROUND_SIZE / DIRT_TILE_SIZE;
      dirtTexture.repeat.set(repeats, repeats);
      this.groundMaterialDirt = new THREE.MeshStandardMaterial({ map: dirtTexture, roughness: 1 });
    }
    this.ground.material = this.groundMaterialDirt;
    this.grid.visible = false;

    // Start roughly where the orbit camera already was (so entering feels
    // continuous rather than an disorienting jump), at a fixed eye height
    // and facing whichever way the orbit camera was already looking.
    this.walkPosition.set(this.camera.position.x, WALK_EYE_HEIGHT, this.camera.position.z);
    const lookDir = new THREE.Vector3();
    this.camera.getWorldDirection(lookDir);
    this.walkYaw = Math.atan2(-lookDir.x, -lookDir.z);
    this.walkPitch = Math.max(-WALK_PITCH_LIMIT, Math.min(WALK_PITCH_LIMIT, Math.asin(Math.max(-1, Math.min(1, lookDir.y)))));
    this.camera.position.copy(this.walkPosition);

    this.walkKeysDown.clear();
    window.addEventListener('keydown', this.handleWalkKeyDown);
    window.addEventListener('keyup', this.handleWalkKeyUp);
    document.addEventListener('mousemove', this.handleWalkMouseMove);
    this.renderer.domElement.requestPointerLock();

    this.walkLastTime = 0;
    this.walkAnimationFrame = requestAnimationFrame(this.walkTick);
    this.onWalkModeChange?.(true);
  }

  /** Leaves walking mode, restoring the orbit camera's pre-walk pose,
   * color mode, and the analytic ground/grid. Safe to call even if
   * walking mode isn't active (a no-op). See enterWalkMode's own doc for
   * the ways this can be triggered. */
  exitWalkMode(): void {
    if (!this.walkActive) return;
    this.walkActive = false;

    if (this.walkAnimationFrame !== null) {
      cancelAnimationFrame(this.walkAnimationFrame);
      this.walkAnimationFrame = null;
    }
    window.removeEventListener('keydown', this.handleWalkKeyDown);
    window.removeEventListener('keyup', this.handleWalkKeyUp);
    document.removeEventListener('mousemove', this.handleWalkMouseMove);
    this.walkKeysDown.clear();
    if (document.pointerLockElement === this.renderer.domElement) document.exitPointerLock();

    this.ground.material = this.groundMaterialNormal;
    this.grid.visible = true;

    if (this.preWalk) {
      this.setOptions({ colorMode: this.preWalk.colorMode });
      this.camera.position.copy(this.preWalk.cameraPosition);
      this.controls.target.copy(this.preWalk.controlsTarget);
      this.camera.near = this.preWalk.near;
      this.camera.far = this.preWalk.far;
      this.camera.updateProjectionMatrix();
      this.preWalk = null;
    }
    this.controls.enabled = true;
    this.controls.update();
    this.render();
    this.onWalkModeChange?.(false);
  }

  private handleWalkKeyDown = (e: KeyboardEvent): void => {
    if (!WALK_KEYS.has(e.code)) return;
    this.walkKeysDown.add(e.code);
    e.preventDefault();
  };

  private handleWalkKeyUp = (e: KeyboardEvent): void => {
    if (!WALK_KEYS.has(e.code)) return;
    this.walkKeysDown.delete(e.code);
    e.preventDefault();
  };

  /** Only actually looks around while pointer-locked (the browser only
   * dispatches movementX/movementY-bearing mousemove events during
   * pointer lock in the first place, so this guard is mostly documentary,
   * but it also means an accidental stray mousemove right at exit can't
   * apply a spurious look delta). */
  private handleWalkMouseMove = (e: MouseEvent): void => {
    if (!this.walkActive || document.pointerLockElement !== this.renderer.domElement) return;
    this.walkYaw -= e.movementX * WALK_MOUSE_SENSITIVITY;
    this.walkPitch = Math.max(-WALK_PITCH_LIMIT, Math.min(WALK_PITCH_LIMIT, this.walkPitch - e.movementY * WALK_MOUSE_SENSITIVITY));
  };

  private walkTick = (time: number): void => {
    if (!this.walkActive) return;
    const dt = this.walkLastTime ? Math.min(0.1, (time - this.walkLastTime) / 1000) : 0;
    this.walkLastTime = time;

    this.camera.quaternion.setFromEuler(new THREE.Euler(this.walkPitch, this.walkYaw, 0, 'YXZ'));

    const moving =
      this.walkKeysDown.has('KeyW') || this.walkKeysDown.has('KeyS') || this.walkKeysDown.has('KeyA') || this.walkKeysDown.has('KeyD');
    if (moving) {
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
      forward.y = 0;
      forward.normalize();
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
      right.y = 0;
      right.normalize();
      if (this.walkKeysDown.has('KeyW')) this.walkPosition.addScaledVector(forward, WALK_MOVE_SPEED * dt);
      if (this.walkKeysDown.has('KeyS')) this.walkPosition.addScaledVector(forward, -WALK_MOVE_SPEED * dt);
      if (this.walkKeysDown.has('KeyD')) this.walkPosition.addScaledVector(right, WALK_MOVE_SPEED * dt);
      if (this.walkKeysDown.has('KeyA')) this.walkPosition.addScaledVector(right, -WALK_MOVE_SPEED * dt);
      // Flat ground: eye height never changes with horizontal movement.
      this.walkPosition.y = WALK_EYE_HEIGHT;
    }

    this.camera.position.copy(this.walkPosition);
    this.render();
    this.walkAnimationFrame = requestAnimationFrame(this.walkTick);
  };

  setOptions(partial: Partial<DebugRendererOptions>): void {
    this.options = { ...this.options, ...partial };
    if (this.currentTrees.length > 0) this.rebuild(this.currentTrees);
    this.render();
  }

  getOptions(): DebugRendererOptions {
    return { ...this.options };
  }

  /** Loads a single tree, centered at the world origin -- sugar for
   * setForestState with one entry at offset (0, 0), id 0. */
  setState(state: TreeState): void {
    this.setForestState([{ id: 0, offset: [0, 0], state }]);
  }

  /** Loads one or more trees at once, each at its own world-space
   * offset -- the forest renderer entry point. A single-tree host (the
   * "Single tree" UI mode) just calls setState above instead. */
  setForestState(trees: RenderTree[]): void {
    this.currentTrees = trees;
    this.rebuild(trees);
    this.render();
  }

  /** Removing a mesh from the scene alone does *not* free its GPU-side
   * buffers (its instance transform/color attributes) -- three.js only
   * releases those when told to via .dispose(), which fires the internal
   * 'dispose' event WebGLRenderer listens for. rebuild() replaces the
   * branch/leaf InstancedMesh on every scrub, every setOptions() toggle,
   * and every forest-generation live-follow update, so skipping this was
   * a real, unbounded GPU-memory leak -- every rebuild piled another
   * abandoned mesh's buffers onto the GPU without ever freeing the last
   * one, which is exactly the kind of thing that eventually exhausts
   * driver memory and gets the whole context forcibly reclaimed (a
   * "WebGL context lost" crash). The shared branchGeometry/leafGeometry/
   * materials (see the constructor) are untouched here -- only this
   * mesh's own instance buffers are freed. */
  private disposeMesh(mesh: THREE.InstancedMesh | null): void {
    if (!mesh) return;
    this.scene.remove(mesh);
    mesh.dispose();
  }

  private rebuild(trees: readonly RenderTree[]): void {
    this.disposeMesh(this.branchMesh);
    this.disposeMesh(this.leafMesh);

    // maxHydraulicResistance is computed across *every* tree being shown
    // at once, so the hydraulicStress color mode's heatmap stays on one
    // consistent scale across a whole forest scene rather than each tree
    // normalizing against only its own max.
    let maxHydraulicResistance = 0;
    let totalSegments = 0;
    let totalLeaves = 0;
    for (const t of trees) {
      totalSegments += t.state.segments.length;
      totalLeaves += this.options.showLeaves ? t.state.leaves.length : 0;
      for (const s of t.state.segments) maxHydraulicResistance = Math.max(maxHydraulicResistance, s.hydraulicResistance);
    }
    const colorMode = getColorMode(this.options.colorMode);
    const isPhoto = this.options.colorMode === 'photo';

    // "Photo" mode is the only one that pays for real-time shadows: with
    // nothing set to cast/receive, the always-on shadow map (see
    // constructor) does essentially no work, so every other mode stays
    // exactly as fast as before.
    this.sunLight.castShadow = isPhoto;
    this.ground.receiveShadow = isPhoto;

    // --- Branch skeleton / thickness ---
    const branchMesh = new THREE.InstancedMesh(this.branchGeometry, this.branchMaterial, Math.max(1, totalSegments));
    branchMesh.count = totalSegments;
    branchMesh.castShadow = isPhoto;
    branchMesh.receiveShadow = isPhoto;
    this.branchIndexToTreeId = new Array(totalSegments);
    this.branchIndexToSegmentId = new Array(totalSegments);

    const m = new THREE.Matrix4();
    const up = new THREE.Vector3(0, 1, 0);
    const forward = new THREE.Vector3(0, 0, 1);
    const dir = new THREE.Vector3();
    const mid = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scaleVec = new THREE.Vector3();
    const startV = new THREE.Vector3();
    const endV = new THREE.Vector3();

    let branchIndex = 0;
    for (const t of trees) {
      const [ox, oz] = t.offset;
      const tipBudBySegmentId = new Map<number, Bud>();
      for (const bud of t.state.buds) {
        if (bud.status !== 'dead') tipBudBySegmentId.set(bud.segmentId, bud);
      }
      for (const s of t.state.segments) {
        startV.set(s.start[0] + ox, s.start[1], s.start[2] + oz);
        endV.set(s.end[0] + ox, s.end[1], s.end[2] + oz);
        const len = Math.max(0.001, distance(s.start, s.end));
        dir.subVectors(endV, startV).normalize();
        quat.setFromUnitVectors(up, dir);
        mid.addVectors(startV, endV).multiplyScalar(0.5);
        const radius = this.options.showThickness ? Math.max((s.baseRadius + s.tipRadius) / 2, 0.003) : SKELETON_RADIUS;
        scaleVec.set(radius, len, radius);
        m.compose(mid, quat, scaleVec);
        branchMesh.setMatrixAt(branchIndex, m);
        branchMesh.setColorAt(
          branchIndex,
          colorMode.color({ segment: s, tipBud: tipBudBySegmentId.get(s.id), currentYear: t.state.year, maxHydraulicResistance })
        );
        this.branchIndexToTreeId[branchIndex] = t.id;
        this.branchIndexToSegmentId[branchIndex] = s.id;
        branchIndex++;
      }
    }
    branchMesh.instanceMatrix.needsUpdate = true;
    if (branchMesh.instanceColor) branchMesh.instanceColor.needsUpdate = true;
    this.scene.add(branchMesh);
    this.branchMesh = branchMesh;

    // --- Leaves ---
    if (totalLeaves > 0) {
      const geometry = isPhoto ? this.leafPhotoGeometry : this.leafGeometry;
      const material = isPhoto ? this.leafPhotoMaterial : this.leafMaterial;
      const leafMesh = new THREE.InstancedMesh(geometry, material, totalLeaves);
      leafMesh.count = totalLeaves;
      leafMesh.castShadow = isPhoto;
      leafMesh.receiveShadow = isPhoto;
      this.leafIndexToTreeId = new Array(totalLeaves);
      this.leafIndexToLeafId = new Array(totalLeaves);
      const leafColor = new THREE.Color('#4a8c3f');
      const tint = new THREE.Color();
      let leafIndex = 0;
      for (const t of trees) {
        const [ox, oz] = t.offset;
        for (const leaf of t.state.leaves) {
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
            mid.set(leaf.position[0] + ox, leaf.position[1], leaf.position[2] + oz);
            m.compose(mid, quat, scaleVec);
            // Subtle per-leaf color variation (deterministic from id) so a
            // dense canopy doesn't read as one flat-shaded texture repeated
            // thousands of times.
            const jitter = ((leaf.id * 2654435761) >>> 0) / 0xffffffff;
            tint.setHSL(0.3 + jitter * 0.06, 0.5 + jitter * 0.15, 0.42 + jitter * 0.16);
            leafMesh.setColorAt(leafIndex, tint);
          } else {
            const r = Math.max(0.015, Math.sqrt(leaf.area / Math.PI));
            m.makeScale(r, r, r);
            m.setPosition(leaf.position[0] + ox, leaf.position[1], leaf.position[2] + oz);
            leafMesh.setColorAt(leafIndex, leafColor);
          }
          leafMesh.setMatrixAt(leafIndex, m);
          this.leafIndexToTreeId[leafIndex] = t.id;
          this.leafIndexToLeafId[leafIndex] = leaf.id;
          leafIndex++;
        }
      }
      leafMesh.instanceMatrix.needsUpdate = true;
      if (leafMesh.instanceColor) leafMesh.instanceColor.needsUpdate = true;
      this.scene.add(leafMesh);
      this.leafMesh = leafMesh;
    } else {
      this.leafMesh = null;
      this.leafIndexToTreeId = [];
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
    if (this.currentTrees.length === 0) return null;
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const targets = [this.branchMesh, this.leafMesh].filter((x): x is THREE.InstancedMesh => x !== null);
    const hits = this.raycaster.intersectObjects(targets, false);
    if (hits.length === 0) return null;
    const hit = hits[0];
    if (hit.instanceId === undefined) return null;
    if (hit.object === this.branchMesh) {
      const treeId = this.branchIndexToTreeId[hit.instanceId];
      const segId = this.branchIndexToSegmentId[hit.instanceId];
      const tree = this.currentTrees.find((t) => t.id === treeId);
      const segment = tree?.state.segments.find((s) => s.id === segId);
      if (!tree || !segment) return null;
      const tipBud = tree.state.buds.find((b) => b.segmentId === segId && b.status !== 'dead');
      return { kind: 'segment', treeId, segment, tipBud };
    }
    if (hit.object === this.leafMesh) {
      const treeId = this.leafIndexToTreeId[hit.instanceId];
      const leafId = this.leafIndexToLeafId[hit.instanceId];
      const tree = this.currentTrees.find((t) => t.id === treeId);
      const leaf = tree?.state.leaves.find((l) => l.id === leafId);
      if (!tree || !leaf) return null;
      return { kind: 'leaf', treeId, leaf };
    }
    return null;
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.exitWalkMode();
    this.renderer.dispose();
    this.branchGeometry.dispose();
    this.leafGeometry.dispose();
    this.branchMaterial.dispose();
    this.leafMaterial.dispose();
    this.leafPhotoGeometry.dispose();
    this.leafPhotoMaterial.dispose();
    this.leafTexture.dispose();
    this.groundMaterialNormal.dispose();
    this.groundMaterialDirt?.map?.dispose();
    this.groundMaterialDirt?.dispose();
  }
}
