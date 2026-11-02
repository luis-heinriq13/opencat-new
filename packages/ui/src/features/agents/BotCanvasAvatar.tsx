import {
  autoInk,
  type BotAvatarShading,
  type BotAvatarState,
  type DrawConfig,
  draw,
  getOpenCatMascotShape,
  LIGHT_DEFAULTS,
  type OpenCatMascotId,
  OVERSCAN,
  pointer,
  RISE,
  restPose,
  richer,
  Sim,
  subscribe,
} from "@openbot/brand";
import { prefersReducedMotion } from "@openbot/ui/utils";
import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, onCleanup, onSettled } from "solid-js";

function hashSeed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 1000) / 1000;
}

const DEFAULT_FALLBACK_COLOR = "#0055ff";
const DEFAULT_WEAR_COLOR = "#27272b";
const pathCache = new Map<string, Path2D>();
function getPath(d: string): Path2D {
  let p = pathCache.get(d);
  if (!p) {
    p = new Path2D(d);
    pathCache.set(d, p);
  }
  return p;
}

export interface BotCanvasAvatarProps {
  shape?: string;
  mascot?: OpenCatMascotId;
  size?: number;
  color?: string;
  ink?: string;
  state?: BotAvatarState;
  shading?: BotAvatarShading;
  playing?: boolean;
  interactive?: boolean;
  seed?: string | number;
  speed?: number;
  class?: string;
  style?: JSX.CSSProperties | Record<string, string | number>;
  onClick?: (e: MouseEvent) => void;
}

export function BotCanvasAvatar(props: BotCanvasAvatarProps) {
  let canvasRef: HTMLCanvasElement | undefined;
  let sim: Sim | null = null;
  let unsubTicker: (() => void) | null = null;
  let observer: IntersectionObserver | null = null;
  let isIntersecting = true;

  const [measuredSize, setMeasuredSize] = createSignal<number | null>(null);
  const size = () => props.size ?? measuredSize() ?? 64;
  const stateKey = (): BotAvatarState => props.state ?? "default";
  const playing = () => props.playing !== false && !prefersReducedMotion();
  const interactive = () => props.interactive !== false;
  const speed = () => props.speed ?? 1;

  const mascotData = createMemo(() => {
    const key = props.mascot ?? props.shape ?? "opencat";
    return getOpenCatMascotShape(key);
  });

  const seedNum = createMemo(() => {
    if (typeof props.seed === "number") return Math.min(1, Math.max(0, props.seed));
    if (typeof props.seed === "string") return hashSeed(props.seed);
    return hashSeed(props.shape ?? "opencat");
  });

  // Effective shading: for <= 32px, fallback to smooth to keep CPU cool
  const shadingMode = (): BotAvatarShading => {
    if (size() <= 32) return "smooth";
    return props.shading ?? (size() > 48 ? "plastic" : "smooth");
  };

  const bodyColor = createMemo(() => {
    const raw = props.color ?? DEFAULT_FALLBACK_COLOR;
    return richer(raw, 0);
  });

  const inkColor = createMemo(() => {
    return props.ink ?? autoInk(bodyColor());
  });

  const lit = createMemo(() => {
    return LIGHT_DEFAULTS[shadingMode() === "fabric" ? "fabric" : "other"];
  });

  const cfg = createMemo((): DrawConfig => {
    const m = mascotData();
    const l = lit();
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
      still: !playing(),
      wear: { hat: "none", glasses: "none", headphones: false, bowTie: false, color: DEFAULT_WEAR_COLOR },
    };
  });

  const paint = () => {
    if (!canvasRef) return;
    const px = size();
    if (!px) return;
    const dpr = Math.min(2, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
    const want = Math.round(px * OVERSCAN * dpr);
    if (canvasRef.width !== want || canvasRef.height !== want) {
      canvasRef.width = want;
      canvasRef.height = want;
    }
    const ctx = canvasRef.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const c = cfg();
    c.dpr = dpr;

    const currentPose = sim && playing() ? sim.pose : restPose(stateKey());
    draw(ctx, px, currentPose, c);
  };

  const startLoop = () => {
    if (unsubTicker || !playing() || !isIntersecting) return;
    const REACH = 3;
    unsubTicker = subscribe((dt: number) => {
      if (!sim) return;
      if (interactive() && !Number.isNaN(pointer.x) && canvasRef) {
        const r = canvasRef.getBoundingClientRect();
        const box = r.width / OVERSCAN || 1;
        const dx = (pointer.x - (r.left + r.width / 2)) / box;
        const dy = (pointer.y - (r.top + r.height / 2 + RISE * box)) / box;
        const d = Math.hypot(dx, dy);
        const strength = d < 1 ? 1 : d > REACH ? 0 : 1 - (d - 1) / (REACH - 1);
        sim.setPointer(dx / Math.max(1, d), dy / Math.max(1, d), strength);
      } else {
        sim.setPointer(0, 0, 0);
      }
      sim.update(dt * speed());
      paint();
    });
  };

  const stopLoop = () => {
    if (unsubTicker) {
      unsubTicker();
      unsubTicker = null;
    }
  };

  onSettled(() => {
    if (canvasRef && props.size === undefined) {
      const rect = canvasRef.getBoundingClientRect();
      if (rect.width > 0) {
        setMeasuredSize(Math.round(rect.width / OVERSCAN));
      }
    }

    sim = new Sim(seedNum(), stateKey());

    if (typeof IntersectionObserver !== "undefined" && canvasRef) {
      observer = new IntersectionObserver(([entry]) => {
        isIntersecting = entry?.isIntersecting ?? true;
        if (isIntersecting && playing()) {
          startLoop();
        } else {
          stopLoop();
        }
      });
      observer.observe(canvasRef);
    }

    if (playing()) {
      startLoop();
    } else {
      paint();
    }
  });

  onCleanup(() => {
    stopLoop();
    observer?.disconnect();
    observer = null;
    sim = null;
  });

  createEffect(
    () => stateKey(),
    (state) => {
      if (sim) {
        sim.setState(state);
      }
    },
  );

  createEffect(
    () => playing(),
    (isPlaying) => {
      if (isPlaying && isIntersecting) {
        startLoop();
      } else {
        stopLoop();
        paint();
      }
    },
  );

  // Repaint when appearance config changes
  createEffect(
    () => cfg(),
    () => {
      paint();
    },
  );

  const handleClick = (e: MouseEvent) => {
    if (interactive() && playing() && sim) {
      sim.poke();
    }
    props.onClick?.(e);
  };

  const hasExplicitSize = () => typeof props.size === "number";
  const dim = () => `${size() * OVERSCAN}px`;
  const pull = (k: number) => `${-size() * k}px`;
  const side = (OVERSCAN - 1) / 2;

  const styleObj = () => {
    if (hasExplicitSize()) {
      return {
        display: "inline-block",
        "vertical-align": "middle",
        width: dim(),
        height: dim(),
        "margin-left": pull(side),
        "margin-right": pull(side),
        "margin-top": pull(side + RISE),
        "margin-bottom": pull(side - RISE),
        "flex-shrink": 0,
        ...(typeof props.style === "object" ? props.style : {}),
      };
    }
    return {
      display: "block",
      "flex-shrink": 0,
      ...(typeof props.style === "object" ? props.style : {}),
    };
  };

  return (
    <canvas ref={canvasRef} class={`bot-canvas-avatar ${props.class ?? ""}`} style={styleObj()} onClick={handleClick} />
  );
}
