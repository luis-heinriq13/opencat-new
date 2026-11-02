import { getOpenCatMascotShape, type OpenCatMascotId } from "@openbot/brand/bot-avatar-shapes";
import type * as BotEngineNS from "@openbot/brand/vendor/bot-avatars";
import type { BotAvatarShading, BotAvatarState, FurStyle } from "@openbot/brand/vendor/bot-avatars";
import { pointer, subscribe, tickerStats } from "@openbot/brand/vendor/bot-avatars/ticker";
import { prefersReducedMotion } from "@openbot/ui/utils";
import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, onCleanup, onSettled, Show } from "solid-js";

function hashSeed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 1000) / 1000;
}

const DEFAULT_FALLBACK_COLOR = "#0055ff";
const DEFAULT_WEAR_COLOR = "#27272b";
/* Pelo curto nos rostos pequenos: o felpudo chega, sem comer as orelhas, a antena e os espinhos.
   Nos grandes entra o pelo padrão da biblioteca. */
const PELO_CURTO: FurStyle = { length: 0.45, density: 1.6, fuzz: 0.5, clumps: 0.3, curl: 0.45, gravity: 0.75 };
const pathCache = new Map<string, Path2D>();
function getPath(d: string): Path2D {
  let p = pathCache.get(d);
  if (!p) {
    p = new Path2D(d);
    pathCache.set(d, p);
  }
  return p;
}

/** The heavy canvas engine loads after the first paint, so application start keeps its speed. */
const ENGINE_MODULE_ID = () => import("@openbot/brand/vendor/bot-avatars");

export interface BotCanvasAvatarProps {
  shape?: string;
  mascot?: OpenCatMascotId;
  size?: number;
  color?: string;
  ink?: string;
  state?: BotAvatarState;
  shading?: BotAvatarShading;
  playing?: boolean;
  /** `full`: head turns, hop, blink, material at the top rate. `subtle`: eyes, blink, a
      gentle sway and an occasional seeded hop. */
  motion?: "full" | "subtle";
  interactive?: boolean;
  seed?: string | number;
  speed?: number;
  class?: string;
  style?: JSX.CSSProperties | Record<string, string | number>;
  onClick?: (e: MouseEvent) => void;
  /** Shown while the engine loads below the first paint and if the canvas engine fails. */
  fallback?: JSX.Element;
}

/** Per-avatar facts for the `window.__opencatAvatars()` probe: an arbitrary census the perf
    test reads over the remote debugging port. */
interface AvatarDebugInfo {
  playing: boolean;
  visible: boolean;
  ready: boolean;
  failed: boolean;
  size: number;
  motion: string;
}
export interface OpencatAvatarsDebug {
  avatars: number;
  animating: number;
  engineReady: number;
  failed: number;
  visible: number;
  fullMotion: number;
  ticker: ReturnType<typeof tickerStats>;
}

declare global {
  interface Window {
    __opencatAvatars?: () => OpencatAvatarsDebug;
  }
}

const avatarDebugSet = new Set<() => AvatarDebugInfo>();
let debugInstalled = false;
function installDebug() {
  if (debugInstalled || typeof window === "undefined") return;
  debugInstalled = true;
  window.__opencatAvatars = () => {
    let avatars = 0;
    let animating = 0;
    let engineReady = 0;
    let failed = 0;
    let visible = 0;
    let full = 0;
    for (const read of avatarDebugSet) {
      const info = read();
      avatars++;
      if (info.playing) animating++;
      if (info.ready) engineReady++;
      if (info.failed) failed++;
      if (info.visible) visible++;
      if (info.motion === "full") full++;
    }
    return { avatars, animating, engineReady, failed, visible, fullMotion: full, ticker: tickerStats() };
  };
}

export function BotCanvasAvatar(props: BotCanvasAvatarProps) {
  let canvasRef: HTMLCanvasElement | undefined;
  let sim: BotEngineNS.Sim | null = null;
  let observer: IntersectionObserver | null = null;
  let unsubClock: (() => void) | null = null;
  let unsubLanded: (() => void) | null = null;
  let canvasHooked = false;
  let isVisible = true;
  let sinceHop = 0;
  let hopInterval = 6;

  installDebug();

  const [engine, setEngine] = createSignal<typeof BotEngineNS | null>(null);
  const [engineFailed, setEngineFailed] = createSignal(false);
  const [measuredSize, setMeasuredSize] = createSignal<number | null>(null);
  const size = () => props.size ?? measuredSize() ?? 64;
  const stateKey = (): BotAvatarState => props.state ?? "default";
  const playing = () => props.playing !== false && !prefersReducedMotion();
  const interactive = () => props.interactive !== false;
  const speed = () => props.speed ?? 1;
  const fullMotion = () => props.motion === "full";
  /** Cheap sides give their slice of the frame budget away first: the sidebar rows
      throttle, the working header keeps its rate. */
  const fpsTarget = () => (fullMotion() ? 20 : 15);
  const weight = () => (size() <= 32 ? 1 : size() <= 48 ? 2 : 3);

  const mascotData = createMemo(() => {
    const key = props.mascot ?? props.shape ?? "opencat";
    return getOpenCatMascotShape(key);
  });

  const seedNum = createMemo(() => {
    if (typeof props.seed === "number") return Math.min(1, Math.max(0, props.seed));
    if (typeof props.seed === "string") return hashSeed(props.seed);
    return hashSeed(props.shape ?? "opencat");
  });

  /** Small avatars stay on the plain smooth shading, which is vector slices and never bakes
      a Poisson form; the plastic material only shows at the large ones. */
  const shadingMode = (): BotAvatarShading => props.shading ?? "fabric";
  /** The furred look everywhere; the pile is queued on idle time, so the body shows as a
      plain smooth slice until the fur lands. */
  const furStyle = (): FurStyle => {
    if (size() <= 48) return PELO_CURTO;
    const ns = engine();
    return ns ? ns.FUR_STOCK : PELO_CURTO;
  };

  const bodyColor = createMemo(() => {
    const raw = props.color ?? DEFAULT_FALLBACK_COLOR;
    const ns = engine();
    return ns ? ns.richer(raw, 0) : raw;
  });

  const inkColor = createMemo(() => {
    if (props.ink) return props.ink;
    const ns = engine();
    return ns ? ns.autoInk(bodyColor()) : "#1b1b1f";
  });

  const makeCfg = (): BotEngineNS.DrawConfig | null => {
    const ns = engine();
    if (!ns) return null;
    const m = mascotData();
    const l = ns.LIGHT_DEFAULTS[shadingMode() === "fabric" ? "fabric" : "other"];
    return {
      path: getPath(m.path),
      face: "eyes",
      faceX: m.preset.faceX,
      faceY: m.preset.faceY,
      faceScale: m.preset.faceScale,
      color: bodyColor(),
      ink: inkColor(),
      shading: shadingMode(),
      shadow: l.shadow,
      highlight: l.highlight,
      depth: 0.65,
      roundness: 1,
      vivid: 0,
      light: l.light,
      rim: l.rim,
      spread: l.spread,
      typeKey: `mascot:${m.mascot}`,
      // Never a synchronous bake: the form plumps up in idle time while the plain
      // slices stand in, so starting the app never blocks on the fur.
      still: false,
      fur: furStyle(),
      wear: { hat: "none", glasses: "none", headphones: false, bowTie: false, color: DEFAULT_WEAR_COLOR },
    };
  };

  const paint = () => {
    const ns = engine();
    if (!canvasRef || !ns) return;
    const px = size();
    if (!px) return;
    const dpr = Math.min(2, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
    const want = Math.round(px * OVERSCAN_AT * dpr);
    if (canvasRef.width !== want || canvasRef.height !== want) {
      canvasRef.width = want;
      canvasRef.height = want;
    }
    const ctx = canvasRef.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const c = makeCfg();
    if (!c) return;
    c.dpr = dpr;
    const currentPose = sim && playing() ? sim.pose : ns.restPose(stateKey());
    try {
      ns.draw(ctx, px, currentPose, c);
    } catch {
      /* One bad frame must never take the avatar down: the SVG stands in below. */
      failEngine();
    }
  };

  const failEngine = () => {
    stopClock();
    unsubLanded?.();
    unsubLanded = null;
    observer?.disconnect();
    observer = null;
    sim = null;
    setEngineFailed(true);
  };

  const advance = (dt: number) => {
    const ns = engine();
    if (!ns || !sim || !canvasRef || engineFailed()) return;
    if (!isVisible) return;
    if (fullMotion() && interactive() && !Number.isNaN(pointer.x)) {
      const r = canvasRef.getBoundingClientRect();
      const box = r.width / OVERSCAN_AT || 1;
      const dx = (pointer.x - (r.left + r.width / 2)) / box;
      const dy = (pointer.y - (r.top + r.height / 2 + RISE_AT * box)) / box;
      const d = Math.hypot(dx, dy);
      const strength = d < 1 ? 1 : d > 3 ? 0 : 1 - (d - 1) / 2;
      sim.setPointer(dx / Math.max(1, d), dy / Math.max(1, d), strength);
    } else {
      sim.setPointer(0, 0, 0);
    }
    if (!fullMotion()) {
      // Subtle rows hop at their own times: staggered by the seed so the sidebar never pulses
      // as one. `poke` is a hop plus a turn, and the idle sway carries the rest.
      sinceHop += dt;
      if (sinceHop > hopInterval) {
        sinceHop = 0;
        hopInterval = 4 + seedNum() * 6;
        if (seedNum() > 0.35) sim.poke();
      }
    }
    sim.update(dt * speed() * (fullMotion() ? 1 : 0.5));
    paint();
  };

  const startClock = () => {
    if (unsubClock || !playing()) return;
    unsubClock = subscribe(advance, { fps: fpsTarget(), weight: weight() });
  };

  const stopClock = () => {
    if (unsubClock) {
      unsubClock();
      unsubClock = null;
    }
  };

  /** Joins a mounted canvas and the loaded engine together: whichever arrives last calls
      this once. */
  const hookCanvas = () => {
    if (!engine() || !canvasRef || canvasHooked || engineFailed()) return;
    canvasHooked = true;
    if (typeof IntersectionObserver !== "undefined" && canvasRef) {
      observer = new IntersectionObserver(([entry]) => {
        const next = entry?.isIntersecting ?? true;
        if (next === isVisible) return;
        isVisible = next;
        if (isVisible && playing()) startClock();
        else stopClock();
      });
      observer.observe(canvasRef);
    }
    if (playing()) {
      if (isVisible) startClock();
      // The first visible frame paints through the clock; a row scrolled out starts at
      // nothing until it comes back, so paint the resting pose now.
      paint();
    } else {
      paint();
    }
  };

  const loadEngine = () => {
    if (engine() || engineFailed()) return;
    ENGINE_MODULE_ID()
      .then((ns) => {
        setEngine(ns);
        sim = new ns.Sim(seedNum(), stateKey());
        // While a shape's fur or form bakes on idle time the draw stood in
        // for it; when the bake lands this repaint shows it, also on a
        // paused avatar that no clock frame would reach.
        unsubLanded = ns.onLanded(() => {
          if (canvasRef && isVisible && !engineFailed()) paint();
        });
        hookCanvas();
        // The shape's own fur warms on idle time: the pile arrives as idle
        // steps and never holds the page.
        typeof window.requestIdleCallback === "function"
          ? window.requestIdleCallback(
              () => {
                const m = mascotData();
                ns.warmPlastic(
                  `mascot:${m.mascot}`,
                  getPath(m.path),
                  Math.round(
                    size() *
                      1.5 *
                      (typeof window !== "undefined" && window.devicePixelRatio
                        ? Math.min(2, window.devicePixelRatio)
                        : 1),
                  ),
                  0.65,
                  true,
                  furStyle(),
                );
              },
              { timeout: 3000 },
            )
          : null;
      })
      .catch(() => failEngine());
  };

  if (typeof window !== "undefined") {
    typeof window.requestIdleCallback === "function"
      ? window.requestIdleCallback(() => loadEngine(), { timeout: 800 })
      : window.setTimeout(() => loadEngine(), 50);
  }

  onCleanup(() => {
    stopClock();
    unsubLanded?.();
    unsubLanded = null;
    observer?.disconnect();
    observer = null;
    sim = null;
    avatarDebugSet.delete(readDebug);
    canvasHooked = false;
  });

  createEffect(
    () => `${shadingMode()}|${bodyColor()}|${inkColor()}|${props.shape ?? ""}|${size()}`,
    () => {
      if (!engine() || !canvasRef) return;
      paint();
    },
  );

  createEffect(
    () => props.state ?? "default",
    (state: BotAvatarState) => {
      sim?.setState(state);
      if (!playing() || !unsubClock) paint();
    },
  );

  createEffect(
    () => `${props.motion ?? "subtle"}|${props.playing !== false}`,
    () => {
      stopClock();
      if (playing() && isVisible && canvasHooked) startClock();
      else paint();
    },
  );

  const readDebug = (): AvatarDebugInfo => ({
    playing: playing() && unsubClock !== null,
    visible: isVisible,
    ready: engine() !== null,
    failed: engineFailed(),
    size: size(),
    motion: fullMotion() ? "full" : "subtle",
  });
  onSettled(() => {
    if (!avatarDebugSet.has(readDebug)) avatarDebugSet.add(readDebug);
  });

  const handleClick = (e: MouseEvent) => {
    // The poke asks the engine for a hop and a turn right here; it costs a state change,
    // never a blocking paint, so the click's own action wins the frame.
    if (interactive() && sim && playing() && !engineFailed()) {
      try {
        sim.poke();
      } catch {
        failEngine();
      }
    }
    props.onClick?.(e);
  };

  const hasExplicitSize = () => typeof props.size === "number";
  const dim = () => `${size() * 1.5}px`;
  const pull = (k: number) => `${-size() * k}px`;
  const side = (1.5 - 1) / 2;

  const styleObj = () => {
    if (hasExplicitSize()) {
      return {
        display: "inline-block",
        "vertical-align": "middle",
        width: dim(),
        height: dim(),
        "margin-left": pull(side),
        "margin-right": pull(side),
        "margin-top": pull(side + 0.1),
        "margin-bottom": pull(side - 0.1),
        "flex-shrink": 0,
        ...(typeof props.style === "object" ? props.style : {}),
      };
    }
    return {
      display: "block",
      // Callers size the wrapping `.agent-avatar`. Keep the canvas' visual
      // overscan inside it, rather than relying on page-specific `> svg` CSS.
      width: "150%",
      height: "150%",
      "margin-left": "-25%",
      "margin-right": "-25%",
      "margin-top": "calc(-35% + var(--agent-avatar-optical-offset, 0px))",
      "margin-bottom": "-15%",
      "flex-shrink": 0,
      ...(typeof props.style === "object" ? props.style : {}),
    };
  };

  return (
    <Show when={engine() !== null && !engineFailed()} fallback={props.fallback}>
      <canvas
        ref={(element) => {
          canvasRef = element;
          // The canvas deliberately overscans the face. Measuring the canvas
          // itself feeds 150% back into the next draw; measure its fixed host.
          const host = element.parentElement;
          const hostSize = host ? Math.min(host.getBoundingClientRect().width, host.getBoundingClientRect().height) : 0;
          if (hostSize > 0 && props.size === undefined) {
            setMeasuredSize(Math.round(hostSize));
          }
          hookCanvas();
          installDebug();
          if (!avatarDebugSet.has(readDebug)) avatarDebugSet.add(readDebug);
        }}
        class={`bot-canvas-avatar ${props.class ?? ""}`}
        style={styleObj()}
        onClick={handleClick}
      />
    </Show>
  );
}

/* Overscan and rise are the vendor's own constants; inlined here so the canvas math needs
   no import before the engine lands. */
const OVERSCAN_AT = 1.5;
const RISE_AT = 0.1;
