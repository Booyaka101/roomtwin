import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { SparkRenderer, SplatEdit, SplatEditRgbaBlendMode, SplatEditSdf, SplatEditSdfType, SplatMesh } from "@sparkjsdev/spark";
import { splatExtension, type CameraView, type Vec3 } from "./config";

export const PLY_WARN_BYTES = 150 * 1024 * 1024;
const MIN_RAYCAST_OPACITY = 0.2;
const PICK_RINGS_PX = [0, 4, 8, 14];
const Y_UP = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const ENTER_MS = 1600;
const GLIDE_MS = 700;

export class SplatLoadError extends Error {}

/** How setView gets there: straight away, a glide from the current view, or a swing in as the room first appears. */
export type Motion = "jump" | "glide" | "enter";

const easeOut = (t: number) => 1 - (1 - t) ** 3;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** A camera move that orbits around a target sliding from one view's to the other's, so it swings rather than cuts through the room. */
export class Flight {
  private readonly from: THREE.Spherical;
  private readonly to: THREE.Spherical;
  private readonly orbit = new THREE.Spherical();

  constructor(
    fromPosition: THREE.Vector3,
    private readonly fromTarget: THREE.Vector3,
    toPosition: THREE.Vector3,
    private readonly toTarget: THREE.Vector3,
    readonly ms: number,
    private readonly ease: (t: number) => number,
  ) {
    this.from = new THREE.Spherical().setFromVector3(fromPosition.clone().sub(fromTarget));
    this.to = new THREE.Spherical().setFromVector3(toPosition.clone().sub(toTarget));
    // The short way round.
    this.from.theta += Math.round((this.to.theta - this.from.theta) / (2 * Math.PI)) * 2 * Math.PI;
  }

  /** Poses the camera `elapsed` ms in and says whether the move is over. */
  pose(elapsed: number, position: THREE.Vector3, target: THREE.Vector3): boolean {
    const t = Math.min(1, Math.max(0, elapsed / this.ms));
    const e = this.ease(t);
    target.lerpVectors(this.fromTarget, this.toTarget, e);
    this.orbit.set(lerp(this.from.radius, this.to.radius, e), lerp(this.from.phi, this.to.phi, e), lerp(this.from.theta, this.to.theta, e));
    position.setFromSpherical(this.orbit).add(target);
    return t >= 1;
  }
}

export interface LoadResult {
  warning?: string;
}

export function webgl2Available(): boolean {
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    // Browsers cap live contexts at around 16, so don't leave the probe holding one.
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    return !!gl;
  } catch {
    return false;
  }
}

/** Message shown for an HTTP failure fetching the splat, with the fix for the common /local mistakes. */
export function httpErrorMessage(url: string, status: number, statusText: string): string {
  const base = `Could not load ${url} (HTTP ${status}${statusText ? " " + statusText : ""}).`;
  if (status !== 404) return base;
  const hint = url.startsWith("/local/")
    ? " Files in /config/www/ are served at /local/, so this URL expects /config/www/" +
      url.slice("/local/".length).split(/[?#]/)[0] +
      ". If you just created the www folder, restart Home Assistant once."
    : "";
  return base + hint;
}

export function plyWarning(url: string, bytes: number): string | undefined {
  if (splatExtension(url) !== "ply" || bytes <= PLY_WARN_BYTES) return undefined;
  const mb = Math.round(bytes / (1024 * 1024));
  return `${url} is a ${mb} MB .ply. Export .spz from Scaniverse, or convert it with the ply-to-spz script in the RoomTwin README, for roughly a tenth of the size and a much faster load on tablets.`;
}

async function download(url: string, signal: AbortSignal, onProgress: (fraction: number) => void): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(url, { signal, credentials: "same-origin" });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new SplatLoadError(`Could not reach ${url}: ${(err as Error).message}. Check your connection to Home Assistant.`);
  }
  if (!response.ok) throw new SplatLoadError(httpErrorMessage(url, response.status, response.statusText));

  const total = Number(response.headers.get("content-length")) || 0;
  if (!response.body || !total) return new Uint8Array(await response.arrayBuffer());

  const bytes = new Uint8Array(total);
  const reader = response.body.getReader();
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (received + value.length > total) {
      // Content-Length described a compressed transfer; fall back to growing the buffer.
      const chunks = [bytes.subarray(0, received), value];
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        chunks.push(next.value);
      }
      const size = chunks.reduce((sum, c) => sum + c.length, 0);
      const joined = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.length;
      }
      return joined;
    }
    bytes.set(value, received);
    received += value.length;
    onProgress(received / total);
  }
  return received === total ? bytes : bytes.subarray(0, received);
}

/**
 * The three.js side of one card: renderer, Spark, orbit camera and the splat itself.
 * Renders on demand only, and not at all while inactive (off-screen or hidden).
 */
export class RoomScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera = new THREE.PerspectiveCamera(60, 1, 0.02, 500);
  readonly controls: OrbitControls;
  /** Maps capture coordinates to a room frame with the floor at y = 0 and up = +Y. */
  readonly root = new THREE.Group();
  mesh: SplatMesh | null = null;
  onRender?: () => void;
  onContextLost?: () => void;
  renders = 0;

  private readonly scene = new THREE.Scene();
  private readonly spark: SparkRenderer;
  private readonly helpers = new THREE.Group();
  private ceiling: SplatEdit | null = null;
  private ceilingSdf: SplatEditSdf | null = null;
  private up = new THREE.Vector3(0, 1, 0);
  private floor = 0;
  private ceilingHeight: number | undefined;
  private sample: Float32Array | null = null;
  private bounds: THREE.Box3 | null = null;
  private active = false;
  private queued = false;
  private pending = true;
  private rafId = 0;
  private disposed = false;
  private flight: Flight | null = null;
  private flightStart = 0;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.setClearColor(0x111111);
    const canvas = this.renderer.domElement;
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      // dispose() forces a context loss of its own.
      if (!this.disposed) this.onContextLost?.();
    });
    container.appendChild(canvas);

    this.spark = new SparkRenderer({ renderer: this.renderer, onDirty: () => this.requestRender() });
    this.scene.add(this.spark);
    this.scene.add(this.root);
    this.scene.add(this.helpers);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    // OrbitControls turns a full canvas height of drag into a full turn, far too fast on a short card.
    this.controls.rotateSpeed = 0.4;
    this.controls.addEventListener("change", () => this.requestRender());
    this.controls.addEventListener("start", () => (this.flight = null));
    // Arrow keys pan, so pins outside the saved view can be reached without a pointer.
    canvas.tabIndex = 0;
    canvas.setAttribute("aria-label", "Room view. Drag to turn, arrow keys to move around.");
    this.controls.listenToKeyEvents(canvas);
  }

  async load(
    url: string,
    { lod, signal, onProgress }: { lod: boolean; signal: AbortSignal; onProgress: (fraction: number) => void },
  ): Promise<LoadResult> {
    const bytes = await download(url, signal, onProgress);
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const fileName = url.split(/[?#]/)[0].split("/").pop() || url;
    const mesh = new SplatMesh({
      fileBytes: bytes,
      fileName,
      minRaycastOpacity: MIN_RAYCAST_OPACITY,
      // .rad files carry their own LoD tree.
      lod: lod && splatExtension(url) !== "rad" ? true : undefined,
    });
    try {
      await mesh.initialized;
    } catch (err) {
      mesh.dispose();
      throw new SplatLoadError(`Could not read ${url} as a splat file: ${(err as Error).message ?? err}`);
    }
    if (signal.aborted || this.disposed) {
      mesh.dispose();
      throw new DOMException("Aborted", "AbortError");
    }
    this.mesh = mesh;
    this.sample = null;
    this.bounds = null;
    this.root.add(mesh);
    this.requestRender();
    return { warning: plyWarning(url, bytes.length) };
  }

  setLodScale(scale: number): void {
    this.spark.lodSplatScale = scale;
    this.requestRender();
  }

  /** Rotates the capture so `up` points along +Y and moves the floor plane to y = 0. */
  setOrientation(up: Vec3, floor: number): void {
    // Every slider move re-applies the config, and re-measuring the bounds takes a 100k-point sort.
    const next = new THREE.Vector3().fromArray(up).normalize();
    if (next.equals(this.up) && floor === this.floor) return;
    this.up.copy(next);
    this.floor = floor;
    this.root.quaternion.setFromUnitVectors(this.up, Y_UP);
    this.root.position.set(0, -floor, 0);
    this.root.updateMatrixWorld(true);
    this.bounds = null;
    this.updateCeiling();
    this.requestRender();
  }

  /** Hides everything more than `height` above the floor, or nothing when undefined. */
  setCeilingCut(height: number | undefined): void {
    this.ceilingHeight = height;
    this.updateCeiling();
    this.requestRender();
  }

  private updateCeiling(): void {
    if (!this.mesh) return;
    if (this.ceilingHeight === undefined) {
      if (this.ceiling) this.mesh.remove(this.ceiling);
      this.ceiling = null;
      this.ceilingSdf = null;
      return;
    }
    if (!this.ceiling || !this.ceilingSdf) {
      // Inverted plane: the inside (local z > 0) is everything above it, multiplied to alpha 0.
      this.ceilingSdf = new SplatEditSdf({ type: SplatEditSdfType.PLANE, invert: true, opacity: 0 });
      this.ceiling = new SplatEdit({ rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY, softEdge: 0.05 });
      this.ceiling.name = "roomtwin ceiling cut";
      this.ceiling.add(this.ceilingSdf);
      this.mesh.add(this.ceiling);
    }
    this.ceilingSdf.position.copy(this.up).multiplyScalar(this.floor + this.ceilingHeight);
    this.ceilingSdf.quaternion.setFromUnitVectors(Z_AXIS, this.up);
  }

  /** Room-frame bounds from a sample of splat centres, trimming the stray floaters every capture has. */
  roomBounds(): THREE.Box3 {
    this.bounds ??= this.measureBounds();
    return this.bounds.clone();
  }

  private measureBounds(): THREE.Box3 {
    const box = new THREE.Box3();
    const sample = this.centreSample();
    if (sample.length === 0) return box;
    const count = sample.length / 3;
    const axes = [new Float32Array(count), new Float32Array(count), new Float32Array(count)];
    const p = new THREE.Vector3();
    this.root.updateMatrixWorld(true);
    for (let i = 0; i < count; i++) {
      p.fromArray(sample, i * 3).applyMatrix4(this.root.matrixWorld);
      axes[0][i] = p.x;
      axes[1][i] = p.y;
      axes[2][i] = p.z;
    }
    for (const values of axes) values.sort();
    const at = (fraction: number) => axes.map((values) => values[Math.floor(count * fraction)]);
    return box.set(new THREE.Vector3().fromArray(at(0.02)), new THREE.Vector3().fromArray(at(0.98)));
  }

  /** Up to ~100k opaque splat centres in capture coordinates, read once per mesh. */
  private centreSample(): Float32Array {
    if (this.sample) return this.sample;
    if (this.disposed) return new Float32Array(0);
    const splats = this.mesh?.splats;
    // With LoD on, Spark keeps only the LoD tree and empties the flat array.
    const source = splats?.getNumSplats() ? splats : (splats as { lodSplats?: typeof splats } | undefined)?.lodSplats;
    if (!source) return new Float32Array(0);
    const count = source.getNumSplats();
    const stride = Math.max(1, Math.floor(count / 100_000));
    const points: number[] = [];
    const keep = (center: THREE.Vector3, opacity: number) => {
      if (opacity >= MIN_RAYCAST_OPACITY) points.push(center.x, center.y, center.z);
    };
    if ("getSplat" in source) {
      // Reading only the sampled splats: walking all 1.7M of a big scan stalls a tablet for most of a second.
      const readable = source as unknown as { getSplat(index: number): { center: THREE.Vector3; opacity: number } };
      for (let i = 0; i < count; i += stride) {
        const { center, opacity } = readable.getSplat(i);
        keep(center, opacity);
      }
    } else {
      // A paged .rad scan can't be read by index.
      source.forEachSplat((index, center, _scales, _q, opacity) => {
        if (index % stride === 0) keep(center, opacity);
      });
    }
    this.sample = new Float32Array(points);
    return this.sample;
  }

  /** Points the camera at a saved view, or stands in the middle of the room looking across it. */
  setView(view: CameraView | undefined, motion: Motion = "jump"): void {
    const fromPosition = this.camera.position.clone();
    const fromTarget = this.controls.target.clone();
    const bounds = this.roomBounds();
    const size = bounds.isEmpty() ? new THREE.Vector3(4, 3, 4) : bounds.getSize(new THREE.Vector3());
    const extent = Math.max(size.x, size.y, size.z);
    this.controls.maxDistance = extent * 3;
    this.controls.minDistance = 0.05;
    if (view) {
      this.camera.position.fromArray(view.position).applyMatrix4(this.root.matrixWorld);
      this.controls.target.fromArray(view.target).applyMatrix4(this.root.matrixWorld);
    } else {
      const center = bounds.isEmpty() ? new THREE.Vector3() : bounds.getCenter(new THREE.Vector3());
      this.controls.target.copy(center);
      this.camera.position.copy(center).add(new THREE.Vector3(0, size.y * 0.1, size.z * 0.4));
    }
    this.flight = null;
    if (motion !== "jump" && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const toPosition = this.camera.position.clone();
      const toTarget = this.controls.target.clone();
      if (motion === "enter") {
        const start = new THREE.Spherical().setFromVector3(toPosition.clone().sub(toTarget));
        // Far enough to read as arriving, not so far that the camera backs out through the wall behind it.
        start.set(start.radius * 1.25, Math.max(0.2, start.phi - 0.15), start.theta - 0.45);
        fromPosition.setFromSpherical(start).add(toTarget);
        fromTarget.copy(toTarget);
      }
      this.flight = new Flight(fromPosition, fromTarget, toPosition, toTarget, motion === "enter" ? ENTER_MS : GLIDE_MS, motion === "enter" ? easeOut : easeInOut);
      this.flightStart = performance.now();
      this.flight.pose(0, this.camera.position, this.controls.target);
    }
    this.camera.near = Math.max(0.01, extent / 2000);
    this.camera.far = extent * 20;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.requestRender();
  }

  /** Remembers the camera so undoDrag() can put it back. */
  markView(): void {
    this.controls.saveState();
  }

  /** Puts the camera back where markView() left it, dropping the motion damping would still carry on. */
  undoDrag(): void {
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.enableDamping = true;
    this.controls.reset();
  }

  /** Current camera in capture coordinates, so it survives a later change of up axis. */
  currentView(): CameraView {
    const toCapture = this.root.matrixWorld.clone().invert();
    const round = (v: THREE.Vector3): Vec3 => v.toArray().map((n) => Math.round(n * 1000) / 1000) as Vec3;
    return {
      position: round(this.camera.position.clone().applyMatrix4(toCapture)),
      target: round(this.controls.target.clone().applyMatrix4(toCapture)),
    };
  }

  captureToWorld(anchor: Vec3, out: THREE.Vector3): THREE.Vector3 {
    return out.fromArray(anchor).applyMatrix4(this.root.matrixWorld);
  }

  /**
   * Capture-space point under a canvas pixel, ignoring anything cut away above the ceiling.
   * Single rays slip between splats on thin objects, so a miss widens to rings of rays around
   * the pixel, like the area under a fingertip, and takes the nearest surface found.
   */
  pick(x: number, y: number): Vec3 | null {
    const mesh = this.mesh;
    if (!mesh) return null;
    const { width, height } = this.renderer.domElement.getBoundingClientRect();
    const raycaster = new THREE.Raycaster();
    // Spark raycasts against a coarse 10-25k LoD subset by default; use what is on screen instead.
    // Spark 2.2.0 also decodes LoD splats with the base encoding, which halves their opacity and
    // lets rays pass through walls, so lend it the LoD encoding for the duration of the cast.
    const coarse = mesh.raycastIndices;
    const packed = mesh.packedSplats;
    const encoding = packed?.splatEncoding;
    mesh.raycastIndices = undefined;
    if (packed?.lodSplats) packed.splatEncoding = packed.lodSplats.splatEncoding;
    try {
      for (const radius of PICK_RINGS_PX) {
        let nearest: THREE.Intersection | undefined;
        const rays = radius ? 8 : 1;
        for (let i = 0; i < rays; i++) {
          const a = (i / rays) * Math.PI * 2;
          const px = x + radius * Math.cos(a);
          const py = y + radius * Math.sin(a);
          raycaster.setFromCamera(new THREE.Vector2((px / width) * 2 - 1, -(py / height) * 2 + 1), this.camera);
          const hit = raycaster
            .intersectObject(mesh, false)
            .find((h) => this.ceilingHeight === undefined || h.point.y <= this.ceilingHeight);
          if (hit && (!nearest || hit.distance < nearest.distance)) nearest = hit;
        }
        if (nearest) {
          const p = nearest.point.clone().applyMatrix4(mesh.matrixWorld.clone().invert());
          return [p.x, p.y, p.z].map((n) => Math.round(n * 1000) / 1000) as Vec3;
        }
      }
      return null;
    } finally {
      mesh.raycastIndices = coarse;
      if (packed) packed.splatEncoding = encoding;
    }
  }

  /** Outlines a light's sphere (or marks a bare point) while editing. */
  showHelper(anchor: Vec3 | null, radius = 0): void {
    this.clearHelpers();
    if (anchor) {
      const center = this.captureToWorld(anchor, new THREE.Vector3());
      const bounds = this.roomBounds();
      const extent = bounds.isEmpty() ? 4 : Math.max(...bounds.getSize(new THREE.Vector3()).toArray());
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(extent / 150, 12, 8),
        new THREE.MeshBasicMaterial({ color: 0xffc107, depthTest: false }),
      );
      dot.position.copy(center);
      this.helpers.add(dot);
      if (radius > 0) {
        const shell = new THREE.LineSegments(
          new THREE.WireframeGeometry(new THREE.SphereGeometry(radius, 24, 12)),
          new THREE.LineBasicMaterial({ color: 0xffc107, transparent: true, opacity: 0.35, depthTest: false }),
        );
        shell.position.copy(center);
        this.helpers.add(shell);
      }
    }
    this.requestRender();
  }

  private clearHelpers(): void {
    for (const helper of this.helpers.children as (THREE.Mesh | THREE.LineSegments)[]) {
      helper.geometry.dispose();
      (helper.material as THREE.Material).dispose();
    }
    this.helpers.clear();
  }

  resize(width: number, height: number): void {
    if (width === 0 || height === 0) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  setActive(active: boolean): void {
    this.active = active;
    if (active && this.pending) this.requestRender();
  }

  requestRender = (): void => {
    this.pending = true;
    if (this.queued || !this.active || this.disposed) return;
    this.queued = true;
    this.rafId = requestAnimationFrame(this.frame);
  };

  private frame = (): void => {
    this.queued = false;
    if (!this.active || this.disposed) return;
    this.pending = false;
    if (this.flight?.pose(performance.now() - this.flightStart, this.camera.position, this.controls.target)) this.flight = null;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.renders++;
    this.onRender?.();
    if (this.flight) this.requestRender();
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    this.clearHelpers();
    this.controls.dispose();
    this.mesh?.dispose();
    // A sort still running when the worker is terminated would reject with nobody listening.
    this.spark.autoUpdate = false;
    this.spark.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
