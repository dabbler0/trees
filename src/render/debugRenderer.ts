import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Bud, BranchSegment, Leaf, TreeState } from '../model/types';
import { distance } from '../model/vec3';
import { COLOR_MODES, getColorMode, type ColorModeId } from './colorSchemes';

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

  private branchMesh: THREE.InstancedMesh | null = null;
  private leafMesh: THREE.InstancedMesh | null = null;
  /** Parallel arrays: instance index -> underlying id, for hover lookups. */
  private branchIndexToSegmentId: number[] = [];
  private leafIndexToLeafId: number[] = [];

  private options: DebugRendererOptions = { ...DEFAULT_OPTIONS };
  private currentState: TreeState | null = null;

  private raycaster = new THREE.Raycaster();
  private pointerNdc = new THREE.Vector2();

  /** Set this to receive hover updates; called with null when nothing is under the pointer. */
  onHover: ((info: HoverInfo | null) => void) | null = null;

  constructor(private container: HTMLElement) {
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 2000);
    this.camera.position.set(12, 10, 16);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 3, 0);
    this.controls.enableDamping = false;
    this.controls.addEventListener('change', () => this.render());

    this.scene.background = new THREE.Color('#cfe8f5');
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#3a2f1f', 1.1));
    const sun = new THREE.DirectionalLight('#fff6e0', 1.4);
    sun.position.set(8, 20, 6);
    this.scene.add(sun);

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(60, 48),
      new THREE.MeshStandardMaterial({ color: '#6f8f5c', roughness: 1 })
    );
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);
    const grid = new THREE.GridHelper(60, 60, '#3f5a35', '#557a48');
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.35;
    this.scene.add(grid);

    this.renderer.domElement.addEventListener('pointermove', this.handlePointerMove);
    this.renderer.domElement.addEventListener('pointerleave', () => this.onHover?.(null));

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /** Point the camera at a tree of the given approximate size. Called
   * once when a whole new simulation is loaded (not on every scrub
   * frame, so it never fights the user's own camera control). */
  frame(height: number, crownWidth: number): void {
    const centerHeight = height / 2;
    const boundingRadius = Math.max(1.5, height / 2, crownWidth / 2) * 1.15;
    const fovRad = (this.camera.fov * Math.PI) / 180;
    const distance = boundingRadius / Math.sin(fovRad / 2);
    this.controls.target.set(0, centerHeight, 0);
    const dir = new THREE.Vector3(0.55, 0.4, 0.75).normalize();
    this.camera.position.copy(dir.multiplyScalar(distance)).add(new THREE.Vector3(0, centerHeight, 0));
    this.camera.near = Math.max(0.05, distance / 200);
    this.camera.far = distance * 10 + boundingRadius;
    this.camera.updateProjectionMatrix();
    this.controls.update();
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

    // --- Branch skeleton / thickness ---
    const segments = state.segments;
    const branchMesh = new THREE.InstancedMesh(this.branchGeometry, this.branchMaterial, Math.max(1, segments.length));
    branchMesh.count = segments.length;
    this.branchIndexToSegmentId = new Array(segments.length);

    const m = new THREE.Matrix4();
    const up = new THREE.Vector3(0, 1, 0);
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
      const leafMesh = new THREE.InstancedMesh(this.leafGeometry, this.leafMaterial, leaves.length);
      leafMesh.count = leaves.length;
      this.leafIndexToLeafId = new Array(leaves.length);
      const leafColor = new THREE.Color('#4a8c3f');
      leaves.forEach((leaf, i) => {
        const r = Math.max(0.015, Math.sqrt(leaf.area / Math.PI));
        m.makeScale(r, r, r);
        m.setPosition(leaf.position[0], leaf.position[1], leaf.position[2]);
        leafMesh.setMatrixAt(i, m);
        leafMesh.setColorAt(i, leafColor);
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
  }
}
