/**
 * Hand-gesture camera control for the true-3D view — camera in, OrbitControls out.
 *
 * Tracking is MediaPipe's Hand Landmarker (@mediapipe/tasks-vision, Apache-2.0),
 * Google's production 21-point hand model: GPU-accelerated, multi-hand, and the
 * most accurate open-source hand tracker that runs fully in the browser. The
 * wasm runtime is served same-origin from /vendor/mediapipe (single-sourced
 * from node_modules by the vite plugin) and the .task model from /models, so
 * nothing depends on a CDN at runtime.
 *
 * This module never touches three.js. It publishes per-second command rates
 * into a shared HandCommand object; the Local3DView render loop feeds them
 * through OrbitControls' public rotateLeft/rotateUp/pan/dolly API — the exact
 * pipeline pointer drags use — so damping, min/max distance and the polar
 * clamp all apply unchanged.
 *
 * Gestures (one active mode at a time, 3-tick hysteresis to switch):
 *   ✋ open palm → orbit    move the hand like dragging the scene
 *   🤏 pinch    → zoom     pinch, then move hand up = zoom in, down = out
 *   ✊ fist      → pan      move the hand like dragging the map
 *   ✌ 2× open   → zoom     spread hands apart = in, together = out
 *
 * Coordinate note: the camera faces the user, so raw image x runs opposite to
 * the user's left/right. Rates are pre-signed so a hand moving right behaves
 * exactly like a mouse drag to the right (the HUD preview is mirrored to
 * match what the user perceives).
 */

import type { HandLandmarker, NormalizedLandmark } from '@mediapipe/tasks-vision';

/** The gesture currently steering the camera. */
export type HandGesture = 'none' | 'orbit' | 'zoom' | 'pan' | 'spread';

/** Lifecycle of the tracker (mirrored into the HUD card). */
export type HandPhase = 'idle' | 'model' | 'camera' | 'live' | 'error';

/**
 * Shared, mutable command block: the tracker writes PER-SECOND rates; the
 * Local3DView render loop multiplies by its frame dt and applies them to
 * OrbitControls. `at` marks freshness so a stalled tracker never keeps the
 * camera drifting.
 */
export interface HandCommand {
  /** rad/s → OrbitControls.rotateLeft (positive ≡ dragging right). */
  theta: number;
  /** rad/s → OrbitControls.rotateUp (positive ≡ dragging down). */
  phi: number;
  /** log(radius)/s → dolly; positive zooms in, negative zooms out. */
  zoom: number;
  /** virtual px/s → OrbitControls.pan (screen convention, right/down positive). */
  panX: number;
  panY: number;
  /** Gesture producing the rates right now ('none' ⇒ rates ≈ 0). */
  gesture: HandGesture;
  /** Hands in frame (0–2). */
  hands: number;
  /** performance.now() of the last tracking tick; 0 = never tracked. */
  at: number;
}

export function emptyHandCommand(): HandCommand {
  return { theta: 0, phi: 0, zoom: 0, panX: 0, panY: 0, gesture: 'none', hands: 0, at: 0 };
}

export interface HandTrackerStatus {
  phase: HandPhase;
  error: string;
  gesture: HandGesture;
  hands: number;
  fps: number;
}

// ── Tuning ─────────────────────────────────────────────────────────────
// Gains: rad (or log-radius, or virtual px) produced by sweeping the hand
// across the full camera frame once.
const ORBIT_X = 3.0;      // ≈172° of orbit per full-width sweep
const ORBIT_Y = 2.6;
const PAN_X = 1200;       // virtual pixels ≈ one screenful panned per sweep
const PAN_Y = 900;        // keeps pan isotropic against a 4:3 frame
const ZOOM_PINCH = 1.6;   // full-height raise ≈ e^1.6 ≈ 5× zoom in
const ZOOM_SPREAD = 2.0;
const DEAD = 0.004;       // normalized deadzone per tick — kills jitter drift
const STEP = 0.09;        // max normalized step per tick — rejects tracking jumps
const SMOOTH = 0.45;      // EMA on emitted rates (1 = raw, 0 = frozen)
const MODE_TICKS = 3;     // consecutive ticks of a new pose before switching
const STALE_MS = 220;     // render-loop freshness window (≈5 lost frames)
const PINCH_ON = 0.5;     // thumb↔index distance / hand scale to enter pinch
const PINCH_OFF = 0.68;   // …and to leave it (hysteresis)
// Reach = how far thumb+index tips sit from the wrist, in hand scales. A
// pinching hand EXTENDS both fingers out to meet: tips land at ~1.4–1.6
// scales. A fist TUCKS them into the palm: ~0.9–1.05. The gap is what
// separates 🤏 from ✊ — thumb↔index distance alone cannot (a fist also
// brings them together).
const REACH_ON = 1.15;    // reachability: pinch enter
const REACH_OFF = 1.05;   // below this a "pinch" is really a fist
const LIMIT = { theta: 4.5, phi: 4, zoom: 2.2, panX: 3500, panY: 2600 };

/** Frames of a tracking update the render loop considers live. */
export const HAND_STALE_MS = STALE_MS;

const WASM_BASE = '/vendor/mediapipe';
const MODEL_URL = '/models/hand_landmarker.task';

// The landmarker (and its wasm) is expensive to build — cache it for the page
// lifetime so toggling hand control off/on never re-downloads anything.
let landmarkerP: Promise<HandLandmarker> | null = null;

async function loadLandmarker(): Promise<HandLandmarker> {
  if (!landmarkerP) {
    landmarkerP = (async () => {
      const { FilesetResolver, HandLandmarker } = await import('@mediapipe/tasks-vision');
      const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
      const make = (delegate: 'GPU' | 'CPU') => HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      // Some GPUs refuse the delegate — the CPU path is always available.
      try {
        return await make('GPU');
      } catch {
        return await make('CPU');
      }
    })().catch((e) => {
      landmarkerP = null; // allow a retry on the next start()
      throw e;
    });
  }
  return landmarkerP;
}

type Mode = 'none' | 'orbit' | 'zoomPinch' | 'pan' | 'spread';
type Pose = 'pinch' | 'open' | 'fist' | 'other';
interface Pt { x: number; y: number }

const dist = (a: NormalizedLandmark, b: NormalizedLandmark): number =>
  Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export class HandTracker {
  /** Shared with the render loop — never replaced, only mutated. */
  readonly cmd: HandCommand;
  /** Latest skeletons, for the HUD preview drawing. */
  landmarks: NormalizedLandmark[][] = [];
  onStatus?: (s: HandTrackerStatus) => void;

  private status: HandTrackerStatus = { phase: 'idle', error: '', gesture: 'none', hands: 0, fps: 0 };
  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  private raf = 0;
  private run = 0;          // start/stop token — stale async paths bail out
  private lastVideoTime = -1;
  private lastTick = 0;
  private mode: Mode = 'none';
  private cand: Mode = 'none';
  private candN = 0;
  private pinchLatched = false;
  private anchor: Pt | null = null;
  private spreadAnchor = 0;
  private s = { theta: 0, phi: 0, zoom: 0, panX: 0, panY: 0 };

  constructor(cmd: HandCommand) {
    this.cmd = cmd;
  }

  async start(video: HTMLVideoElement): Promise<void> {
    const run = ++this.run;
    this.video = video;

    if (!navigator.mediaDevices?.getUserMedia) {
      this.setStatus({ phase: 'error', error: 'Camera API unavailable — the page needs HTTPS (or localhost).' });
      return;
    }

    this.setStatus({ phase: 'model', error: '' });
    let lm: HandLandmarker;
    try {
      lm = await loadLandmarker();
    } catch (e) {
      if (run !== this.run) return;
      this.setStatus({
        phase: 'error',
        error: `Hand-tracking model failed to load (${String((e as Error)?.message ?? e)})`,
      });
      return;
    }
    if (run !== this.run) return;

    this.setStatus({ phase: 'camera', error: '' });
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
    } catch (e) {
      if (run !== this.run) return;
      const name = (e as DOMException)?.name;
      const msg =
        name === 'NotAllowedError' || name === 'SecurityError'
          ? 'Camera permission denied — allow camera access for this site and retry.'
          : name === 'NotFoundError' || name === 'OverconstrainedError'
            ? 'No camera found on this device.'
            : name === 'NotReadableError'
              ? 'Camera is in use by another application.'
              : `Camera unavailable (${name ?? 'unknown error'}).`;
      this.setStatus({ phase: 'error', error: msg });
      return;
    }
    if (run !== this.run) {
      // stop() won the race — release the camera we just obtained.
      this.stream?.getTracks().forEach((t) => t.stop());
      this.stream = null;
      return;
    }

    video.srcObject = this.stream;
    video.muted = true;
    try {
      await video.play();
    } catch {
      // Autoplay is allowed here (muted + user-initiated); ignore edge cases.
    }
    if (run !== this.run) {
      this.stream?.getTracks().forEach((t) => t.stop());
      this.stream = null;
      return;
    }

    this.lastTick = 0;
    this.lastVideoTime = -1;
    this.resetTracking();
    this.setStatus({ phase: 'live', error: '', fps: 0, hands: 0, gesture: 'none' });
    this.loop(lm, run);
  }

  stop(): void {
    this.run++;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) {
      try { this.video.pause(); } catch { /* already detached */ }
      this.video.srcObject = null;
    }
    this.video = null;
    this.landmarks = [];
    this.resetTracking();
    const c = this.cmd;
    c.theta = c.phi = c.zoom = c.panX = c.panY = 0;
    c.gesture = 'none';
    c.hands = 0;
    c.at = 0;
    this.setStatus({ phase: 'idle', error: '', gesture: 'none', hands: 0, fps: 0 });
  }

  // ── Detection loop ──────────────────────────────────────────────────
  private loop(lm: HandLandmarker, run: number): void {
    const tick = () => {
      if (run !== this.run) return;
      this.raf = requestAnimationFrame(tick);
      const v = this.video;
      if (!v || v.readyState < 2 || v.currentTime === this.lastVideoTime) return;
      this.lastVideoTime = v.currentTime;

      const now = performance.now();
      const dt = this.lastTick ? (now - this.lastTick) / 1000 : 0;
      this.lastTick = now;

      let res;
      try {
        res = lm.detectForVideo(v, now);
      } catch {
        return; // transient decode hiccup — next frame will recover
      }
      if (dt > 0.005 && dt < 0.25) {
        const fps = this.status.fps ? this.status.fps * 0.85 + (1 / dt) * 0.15 : 1 / dt;
        this.setStatus({ fps });
      }
      this.landmarks = res.landmarks;
      this.step(res.landmarks, dt || 1 / 30, now);
    };
    this.raf = requestAnimationFrame(tick);
  }

  // ── Gesture state machine + rate emission ──────────────────────────
  private step(hands: NormalizedLandmark[][], dt: number, now: number): void {
    const c = this.cmd;
    c.hands = hands.length;
    c.at = now;

    // 1. Classify the pose we would like to be in.
    let desired: Mode = 'none';
    if (hands.length > 0) {
      const pose0 = this.classify(hands[0]);
      if (hands.length >= 2) {
        const pose1 = this.classify(hands[1]);
        desired = pose0 === 'open' && pose1 === 'open'
          ? 'spread'
          : poseFromPose(pose0);
      } else {
        desired = poseFromPose(pose0);
      }
    }

    // 2. Hysteresis: entering an active mode needs MODE_TICKS consecutive
    //    ticks (flicker can never drive the camera); bailing to 'none' is
    //    immediate so an ambiguous pose stops motion right away.
    if (desired !== this.mode) {
      if (desired === this.cand) this.candN++;
      else { this.cand = desired; this.candN = 1; }
      const need = desired === 'none' ? 1 : MODE_TICKS;
      if (this.candN >= need) {
        this.mode = desired;
        this.cand = 'none';
        this.candN = 0;
        this.s = { theta: 0, phi: 0, zoom: 0, panX: 0, panY: 0 };
      }
    } else {
      this.cand = 'none';
      this.candN = 0;
    }

    // 3. Anchor deltas (always re-anchored, so resuming a gesture never jumps).
    let dx = 0;
    let dy = 0;
    if (hands.length > 0) {
      const p = { x: hands[0][9].x, y: hands[0][9].y }; // palm (middle MCP)
      if (this.anchor) {
        dx = p.x - this.anchor.x;
        dy = p.y - this.anchor.y;
      }
      this.anchor = p;
    } else {
      this.anchor = null;
    }
    let dSpread = 0;
    if (hands.length >= 2) {
      const sp = Math.hypot(
        hands[0][9].x - hands[1][9].x,
        hands[0][9].y - hands[1][9].y,
      );
      if (this.spreadAnchor > 0) dSpread = sp - this.spreadAnchor;
      this.spreadAnchor = sp;
    } else {
      this.spreadAnchor = 0;
    }

    const dz = (v: number): number =>
      Math.abs(v) < DEAD ? 0 : clamp(v, -STEP, STEP);
    dx = dz(dx);
    dy = dz(dy);
    dSpread = dz(dSpread * 1.5);

    // 4. Raw rates for this tick (zero whenever the pose disagrees with the
    //    active mode — the EMA then glides to a stop instead of snapping).
    const raw = { theta: 0, phi: 0, zoom: 0, panX: 0, panY: 0 };
    const driving = this.mode !== 'none' && desired === this.mode;
    if (driving) {
      switch (this.mode) {
        case 'orbit':
          // Perceived-right ≡ drag-right; hand-down ≡ drag-down.
          raw.theta = (-dx * ORBIT_X) / dt;
          raw.phi = (dy * ORBIT_Y) / dt;
          break;
        case 'pan':
          raw.panX = (-dx * PAN_X) / dt;
          raw.panY = (dy * PAN_Y) / dt;
          break;
        case 'zoomPinch':
          raw.zoom = (-dy * ZOOM_PINCH) / dt; // hand up → zoom in
          break;
        case 'spread':
          raw.zoom = (dSpread * ZOOM_SPREAD) / dt; // hands apart → zoom in
          break;
        case 'none':
          break;
      }
    }

    // 5. EMA-smooth, clamp, publish.
    const k = SMOOTH;
    const s = this.s;
    s.theta += (raw.theta - s.theta) * (1 - k);
    s.phi += (raw.phi - s.phi) * (1 - k);
    s.zoom += (raw.zoom - s.zoom) * (1 - k);
    s.panX += (raw.panX - s.panX) * (1 - k);
    s.panY += (raw.panY - s.panY) * (1 - k);
    c.theta = clamp(s.theta, -LIMIT.theta, LIMIT.theta);
    c.phi = clamp(s.phi, -LIMIT.phi, LIMIT.phi);
    c.zoom = clamp(s.zoom, -LIMIT.zoom, LIMIT.zoom);
    c.panX = clamp(s.panX, -LIMIT.panX, LIMIT.panX);
    c.panY = clamp(s.panY, -LIMIT.panY, LIMIT.panY);
    c.gesture = driving ? gestureFromMode(this.mode) : 'none';
    this.setStatus({ gesture: c.gesture, hands: hands.length });
  }

  /**
   * Pose of one hand. Order matters: pinch is checked before fist because a
   * fist also brings thumb and index together — `reach` (how far thumb+index
   * sit from the wrist) is what tells a👌 pinch (reaching out) from a✊ fist
   * (tucked into the palm). The pinch latch adds enter/leave hysteresis so a
   * hand wobbling at the threshold cannot flicker between zoom and pan.
   */
  private classify(lm: NormalizedLandmark[]): Pose {
    const scale = dist(lm[0], lm[9]) || 1e-6; // wrist → middle MCP
    const pinchRatio = dist(lm[4], lm[8]) / scale;
    const reach = (dist(lm[4], lm[0]) + dist(lm[8], lm[0])) / (2 * scale);
    if (this.pinchLatched ? pinchRatio < PINCH_OFF && reach > REACH_OFF
                          : pinchRatio < PINCH_ON && reach > REACH_ON) {
      this.pinchLatched = true;
      return 'pinch';
    }
    this.pinchLatched = false;

    let extended = 0;
    for (const [tip, pip] of [[8, 6], [12, 10], [16, 14], [20, 18]] as const) {
      // A straight finger's tip sits clearly farther from the wrist than its
      // middle joint; a curled one sits closer.
      if (dist(lm[tip], lm[0]) > dist(lm[pip], lm[0]) * 1.08) extended++;
    }
    if (extended >= 4) return 'open';
    if (extended <= 1) return 'fist';
    return 'other';
  }

  private resetTracking(): void {
    this.mode = 'none';
    this.cand = 'none';
    this.candN = 0;
    this.pinchLatched = false;
    this.anchor = null;
    this.spreadAnchor = 0;
    this.s = { theta: 0, phi: 0, zoom: 0, panX: 0, panY: 0 };
  }

  private setStatus(patch: Partial<HandTrackerStatus>): void {
    const next = { ...this.status, ...patch };
    const changed =
      next.phase !== this.status.phase ||
      next.error !== this.status.error ||
      next.gesture !== this.status.gesture ||
      next.hands !== this.status.hands ||
      Math.round(next.fps) !== Math.round(this.status.fps);
    this.status = next;
    if (changed) this.onStatus?.(next);
  }
}

const poseFromPose = (p: Pose): Mode =>
  p === 'pinch' ? 'zoomPinch' : p === 'open' ? 'orbit' : p === 'fist' ? 'pan' : 'none';

const gestureFromMode = (m: Mode): HandGesture =>
  m === 'zoomPinch' ? 'zoom' : m === 'spread' ? 'spread' : m === 'none' ? 'none' : m;
