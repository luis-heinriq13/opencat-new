// @ts-nocheck
/* One animation frame loop for every avatar on the page. Each subscriber
   declares its own fps ceiling and a weight: when a frame runs late, the
   lightest subscribers (small, subtle avatars) throttle first, and the
   important ones keep their rate longest. The loop stops while the tab is
   hidden and while nobody is subscribed, so an off-screen window costs
   nothing. Subscribers get the seconds since their own last tick. */

type Tick = (dt: number) => void;

export interface TickOptions {
  /** The most often this subscriber runs, in frames per second. */
  fps?: number;
  /** Importance, 1 or more. When frames turn late the lowest weighted
      subscribers throttle first, and the heaviest keep their rate. */
  weight?: number;
}

/** The last pointer position on the page, NaN while it is away. */
export const pointer = { x: NaN, y: NaN };

export interface TickerStats {
  subscribers: number;
  activeLastFrame: number;
  frameMs: number;
  /** 1 at full rate; above 1 as late frames throttle the low weights. */
  scale: number;
}

interface Sub {
  fn: Tick;
  /** The clean tick interval in ms at scale 1. */
  base: number;
  last: number;
  weight: number;
}

/** The highest extra throttle: a chosen fps may drop to a quarter of it
    while a frame still runs late. */
const MAX_SCALE = 4;
/** A frame that stays under this many ms keeps scale at 1. */
const FRAME_BUDGET_MS = 12;

const subs = new Map<Tick, Sub>();
let raf = 0;
let last = 0;
let frameMs = 0;
let scale = 1;
let activeLastFrame = 0;

function intervalFor(sub: Sub): number {
  return Math.min(MAX_SCALE, scale) / Math.max(1, sub.weight) * sub.base;
}

function frame(now: number) {
  raf = 0;
  const globalDt = last ? Math.min(0.1, (now - last) / 1000) : 0;
  last = now;
  const startedAt = typeof performance !== "undefined" ? performance.now() : now;
  activeLastFrame = 0;
  for (const sub of subs.values()) {
    if (now - sub.last < intervalFor(sub)) continue;
    const own = sub.last ? Math.min(0.1, (now - sub.last) / 1000) : globalDt;
    sub.last = now;
    activeLastFrame++;
    sub.fn(own);
  }
  const spent = (typeof performance !== "undefined" ? performance.now() : now) - startedAt;
  frameMs = frameMs ? frameMs * 0.7 + spent * 0.3 : spent;
  /* Late frames throttle the cheapest subscribers first; an easy frame
     climbs back toward the full rate. */
  if (frameMs > FRAME_BUDGET_MS) scale = Math.min(MAX_SCALE, scale * 1.35);
  else if (frameMs < 6) scale = Math.max(1, scale / 1.25);
  if (subs.size) raf = requestAnimationFrame(frame);
}

function start() {
  if (raf || typeof document === "undefined" || document.hidden) return;
  for (const sub of subs.values()) sub.last = 0;
  last = 0;
  raf = requestAnimationFrame(frame);
}

let wired = false;
function wire() {
  if (wired || typeof document === "undefined") return;
  wired = true;
  document.addEventListener("pointermove", (e) => { pointer.x = e.clientX; pointer.y = e.clientY; }, { passive: true });
  document.addEventListener("pointerleave", () => { pointer.x = NaN; pointer.y = NaN; });
  window.addEventListener("blur", () => { pointer.x = NaN; pointer.y = NaN; });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    } else if (subs.size) start();
  });
}

export function subscribe(fn: Tick, options: TickOptions = {}): () => void {
  wire();
  subs.set(fn, {
    fn,
    base: typeof options.fps === "number" && options.fps > 0 ? Math.max(16, Math.round(1000 / options.fps)) : 0,
    last: 0,
    weight: typeof options.weight === "number" && options.weight > 0 ? options.weight : 2,
  });
  start();
  return () => {
    subs.delete(fn);
    if (!subs.size && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };
}

export function tickerStats(): TickerStats {
  return {
    subscribers: subs.size,
    activeLastFrame,
    frameMs: Math.round(frameMs * 100) / 100,
    scale: Math.round(Math.min(MAX_SCALE, scale) * 100) / 100,
  };
}
