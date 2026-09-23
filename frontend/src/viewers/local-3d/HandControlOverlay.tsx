/**
 * Hand-control HUD for the true-3D view: a floating card that shows the live
 * camera preview (mirrored, so it reads like a mirror), the 21-point hand
 * skeleton drawn over it, the gesture currently steering the camera, and a
 * compact legend. Error states (no camera / permission denied / model load
 * failure) render in place with a retry — the 3D view itself never breaks.
 *
 * All tracking happens on-device inside HandTracker; this component only
 * renders its output. Frames never leave the browser.
 */

import { useEffect, useRef, type RefObject } from 'react';
import type { HandTracker, HandTrackerStatus, HandGesture } from './handControl';

/** MediaPipe HAND_CONNECTIONS subset, as [start, end] landmark indices. */
const BONES: Array<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];
const TIPS = [4, 8, 12, 16, 20];

const GESTURE_COPY: Record<HandGesture, { emoji: string; label: string; hint: string }> = {
  none: { emoji: '👋', label: 'Show your hand', hint: '✋ open palm to orbit · 🤏 pinch to zoom · ✊ fist to pan' },
  orbit: { emoji: '✋', label: 'Orbit', hint: 'Move your hand — the terrain follows, like dragging it' },
  zoom: { emoji: '🤏', label: 'Zoom', hint: 'Pinched — raise your hand to zoom in, lower to zoom out' },
  pan: { emoji: '✊', label: 'Pan', hint: 'Move your hand to slide the view across the terrain' },
  spread: { emoji: '✌️', label: 'Two-hand zoom', hint: 'Spread hands apart to zoom in, together to zoom out' },
};

interface HandControlOverlayProps {
  tracker: HandTracker;
  status: HandTrackerStatus;
  videoRef: RefObject<HTMLVideoElement>;
  onRetry: () => void;
}

export default function HandControlOverlay({ tracker, status, videoRef, onRetry }: HandControlOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Skeleton painter: runs only while this card is mounted.
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const cv = canvasRef.current;
      if (!cv) return;
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      const w = cv.width;
      const h = cv.height;
      ctx.clearRect(0, 0, w, h);
      const hands = tracker.landmarks;
      if (!hands.length) return;
      const active = status.gesture !== 'none';
      const line = active ? 'rgba(45,212,191,0.95)' : 'rgba(148,163,184,0.85)';
      const joint = active ? '#2dd4bf' : '#94a3b8';
      for (const lm of hands) {
        if (lm.length < 21) continue;
        // Mirror x: the video is CSS-mirrored, so the drawing must match.
        const px = (i: number) => (1 - lm[i].x) * w;
        const py = (i: number) => lm[i].y * h;
        ctx.strokeStyle = line;
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (const [a, b] of BONES) {
          ctx.moveTo(px(a), py(a));
          ctx.lineTo(px(b), py(b));
        }
        ctx.stroke();
        ctx.fillStyle = joint;
        for (let i = 0; i < 21; i++) {
          const tip = TIPS.includes(i);
          ctx.beginPath();
          ctx.arc(px(i), py(i), tip ? 3.2 : 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [tracker, status.gesture]);

  const g = GESTURE_COPY[status.gesture];
  const pill =
    status.phase === 'live'
      ? { text: `LIVE${status.fps ? ` • ${Math.round(status.fps)} fps` : ''}`, cls: 'text-cmd-green' }
      : status.phase === 'error'
        ? { text: 'ERROR', cls: 'text-cmd-red' }
        : status.phase === 'idle'
          ? { text: 'OFF', cls: 'text-cmd-muted' }
          : { text: status.phase === 'model' ? 'Loading model…' : 'Starting camera…', cls: 'text-cmd-amber animate-pulse' };

  return (
    <div className="absolute left-3 top-1/2 -translate-y-1/2 z-40 w-48 rounded-xl border border-cmd-border bg-[#0A1218]/90 backdrop-blur overflow-hidden shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-cmd-border">
        <span className="flex items-center gap-1.5 text-[10px] font-bold text-cmd-ink">
          ✋ Hand control
        </span>
        <span className={`text-[9px] font-bold font-mono ${pill.cls}`}>{pill.text}</span>
      </div>

      {/* Camera preview + skeleton */}
      <div className="relative w-full h-28 bg-black/70">
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className="absolute inset-0 w-full h-full object-cover -scale-x-100 opacity-80"
        />
        <canvas
          ref={canvasRef}
          width={192}
          height={112}
          className="absolute inset-0 w-full h-full"
        />
        {status.phase === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-[9px] text-cmd-red text-center px-2">
            Camera unavailable
          </div>
        )}
      </div>

      {/* Gesture readout */}
      <div className="px-2.5 py-2 border-t border-cmd-border">
        <div className="flex items-baseline gap-1.5">
          <span className="text-sm">{g.emoji}</span>
          <span className="text-xs font-bold text-cmd-ink">{g.label}</span>
          <span className="ml-auto text-[9px] font-mono text-cmd-muted">
            {status.hands} hand{status.hands === 1 ? '' : 's'}
          </span>
        </div>
        <p className="mt-0.5 text-[9.5px] leading-snug text-cmd-muted">{g.hint}</p>
      </div>

      {/* Error + retry */}
      {status.phase === 'error' && status.error && (
        <div className="px-2.5 py-2 border-t border-cmd-border space-y-1.5">
          <p className="text-[9.5px] leading-snug text-cmd-amber">{status.error}</p>
          <button
            onClick={onRetry}
            className="w-full px-2 py-1.5 bg-cmd-teal/90 hover:bg-cmd-teal text-[#071018] text-[10px] font-bold rounded-md transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Legend */}
      <div className="px-2.5 py-1.5 border-t border-cmd-border text-[9px] leading-relaxed text-cmd-muted">
        <div>✋ <span className="text-cmd-ink">Open palm</span> — orbit</div>
        <div>🤏 <span className="text-cmd-ink">Pinch</span> — zoom up/down</div>
        <div>✊ <span className="text-cmd-ink">Fist</span> — pan</div>
        <div>✌️ <span className="text-cmd-ink">Two open hands</span> — spread zoom</div>
      </div>
      <div className="px-2.5 py-1 border-t border-cmd-border text-[8.5px] text-cmd-muted/70">
        On-device MediaPipe tracking — no video leaves this page
      </div>
    </div>
  );
}
