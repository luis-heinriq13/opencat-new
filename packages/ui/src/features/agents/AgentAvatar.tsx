import {
  type Block,
  BloubBot,
  BotEngine,
  type BotFrame,
  DEMI_VIEWBOX,
  makeBlock,
  POSES,
  RAYON,
} from "@norbert_bodziony/bloub";
import {
  type AvatarMood,
  avatarMoodIsBusy,
  avatarMoodPresentation,
  type ShapeSafeStateId,
} from "@openbot/brand/bloub-avatar-motion";
import { subscribe } from "@openbot/brand/vendor/bot-avatars/ticker";
import type { AvatarHue } from "@openbot/contracts/ipc";
import { prefersReducedMotion } from "@openbot/ui/utils";
import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, createUniqueId, For, onSettled, Show } from "solid-js";
import {
  type AvatarMotion,
  avatarHeadColor,
  bloubAvatarProfile,
  type SupportedAvatarSilhouetteId,
} from "../../bloub-avatar";
import type { AgentProfile } from "../../data";
import { createPointerGaze } from "./avatar-pointer-gaze";
import { BotCanvasAvatar } from "./BotCanvasAvatar";

// Cap avatar animation at 30fps: uncapped bloub clocks measured 30% renderer / 24% GPU
// for two visible avatars. The shape is 24-40px, so the eye cannot see the difference.
const AVATAR_FPS = 30;

interface PlushMood {
  state: PlushState;
  /** `null` = the face the seed chose. `failed` and `asleep` set their own face and ignore it. */
  expression: ExpressionId | null;
  /** The mood keeps moving on its own, so the avatar runs without hover. */
  busy: boolean;
}

/*
 * How each mood shows on the plush. Only the eyes and the plush's own felt pieces move; the body, which
 * is the agent's identity, stays still and keeps its colour. No ring, glow or dimming is added round
 * it: a working agent looks up while three felt dots pulse beside it, a waiting one shows a felt dot,
 * a failed turn lowers its eyes and shakes "no" once, and an asleep agent closes its eyes as z's rise.
 */
const PLUSH_MOODS: Readonly<Record<AvatarMood, PlushMood>> = {
  idle: { state: "idle", expression: null, busy: false },
  working: { state: "thinking", expression: "attentif", busy: true },
  connecting: { state: "thinking", expression: "attentif", busy: true },
  waiting: { state: "notify", expression: "curieux", busy: false },
  failed: { state: "failed", expression: null, busy: false },
  responded: { state: "idle", expression: "heureux", busy: false },
  asleep: { state: "asleep", expression: null, busy: false },
};

interface HoverFace {
  state: PlushState;
  /** `null` keeps the resting eyes: the state sets its own face. */
  expression: ExpressionId | null;
}

/**
 * What a resting agent does while it is pointed at or has keyboard focus. Each hover takes one of these
 * at random, and the eyes slide back on leave. They are friendly faces that differ clearly from most
 * resting eyes, also at sidebar size.
 */
const HOVER_WINK: HoverFace = { state: "wink", expression: null };
const HOVER_FACES: readonly HoverFace[] = [
  HOVER_WINK,
  { state: "idle", expression: "surpris" },
  { state: "idle", expression: "excite" },
  { state: "idle", expression: "attentif" },
  { state: "idle", expression: "curieux" },
];

/** A photo has no face to move, so a busy agent's photo breathes: a slow scale of the whole circle. */
const PHOTO_BREATHE = "0.03";

/** The plush body has the same radius as the flat body, but its soft, dark fur edge makes it look
 * smaller. This scale makes it look the same size. Each surface still sizes the box. */
const PLUSH_BODY_STYLE = { transform: "scale(1.15)" } as const;

/** The pose that a still plush shows. The plush plays `thinking`, `asleep` and `failed` on the
 * engine's `idle`. */
function frozenPose(state: PlushState): number {
  return POSES[state === "wink" || state === "wide" || state === "notify" ? state : "idle"];
}

// Motions that rest until pointer/focus arrives. The sidebar is not virtualized, so every
// row would otherwise animate on screen; idle-window profiles showed 83 recalcs/s from
// four resting avatars. A mood with its own motion keeps animating as the busy signal.
const STATIC_MOTIONS: ReadonlySet<AvatarMotion> = new Set(["hover", "idle"]);

// Hover group lookup: the first `[data-avatar-hover]`/control ancestor, since dialogs and
// scroll regions with `[tabindex]` are too wide to count as one.
const HOVER_GROUP = "[data-avatar-hover], button, a, [role='button'], [role='link'], [role='menuitem']";

interface AgentAvatarProps {
  agent?: Pick<AgentProfile, "avatarSeed" | "avatarHue" | "avatarUrl"> | undefined;
  seed?: string | undefined;
  hue?: AvatarHue | null;
  url?: string | null | undefined;
  motion?: AvatarMotion;
  /** What the agent is doing. It chooses the face, never the silhouette. */
  mood?: AvatarMood;
  animationOffset?: number;
  shape?: SupportedAvatarSilhouetteId;
  /** The resting eyes, in place of the seed's. A mood with its own face still shows that face. */
  expression?: ExpressionId;
  /**
   * How a new shape or colour comes in. `cut` swaps it at once: use it where many avatars change
   * together, such as a picker grid, so that they do not all animate at the same time.
   */
  transition?: PlushTransition;
  /**
   * The eyes follow the pointer. The avatar then moves without hover, so use it only where few
   * avatars show. A photo avatar and reduced motion ignore it.
   */
  followPointer?: boolean;
  /**
   * Canvas is the normal mascot after the first paint. Passing `false` is an
   * explicit emergency/static opt-out for a surface that cannot host a canvas.
   * The canvas stays lazy, viewport-aware and keeps the SVG as an immediate
   * fallback, so a failed engine never removes an avatar.
   */
  renderCanvas?: boolean;
  class?: string;
  style?: Record<string, string>;
}

export function AgentAvatar(props: AgentAvatarProps) {
  const seed = () => props.seed ?? props.agent?.avatarSeed ?? "agent";
  const hue = () => (props.hue !== undefined ? props.hue : (props.agent?.avatarHue ?? null));
  const motion = () => props.motion ?? "hover";
  const url = () => (props.url !== undefined ? props.url : (props.agent?.avatarUrl ?? null));
  const mood = (): AvatarMood => props.mood ?? "idle";
  const [imageFailed, setImageFailed] = createSignal(false);
  createEffect(
    () => url(),
    () => {
      setImageFailed(false);
    },
  );
  const className = () => `agent-avatar agent-avatar-motion-${motion()} ${props.class ?? ""}`;
  // The custom property rides with the attribute rather than being set on every avatar: the
  // keyframe is an infinite animation, and a selector that matched all of them would start one
  // behind every resting row in the sidebar.
  const breathe = () => (PLUSH_MOODS[mood()].busy ? PHOTO_BREATHE : undefined);
  const photoStyle = (): Record<string, string> => {
    const amount = breathe();
    return amount ? { ...props.style, "--agent-avatar-breathe": amount } : { ...props.style };
  };
  return (
    <Show
      when={url() && !imageFailed()}
      fallback={
        <GeneratedAvatar
          seed={seed()}
          hue={hue()}
          motion={motion()}
          mood={mood()}
          animationOffset={props.animationOffset}
          shape={props.shape}
          expression={props.expression}
          transition={props.transition ?? "pop"}
          followPointer={props.followPointer === true}
          renderCanvas={props.renderCanvas !== false}
          breathe={breathe()}
          class={className()}
          style={props.style}
        />
      }
    >
      <span
        class={`${className()} agent-avatar-custom`}
        style={photoStyle()}
        data-avatar="image"
        data-mood={mood()}
        data-breathe={breathe()}
        aria-hidden="true"
      >
        <AvatarImage url={url()} onFailed={() => setImageFailed(true)} />
      </span>
    </Show>
  );
}

function AvatarImage(props: { url: string | null; onFailed: () => void }) {
  return <img src={props.url ?? ""} alt="" draggable={false} onError={() => props.onFailed()} />;
}

/**
 * Orbit rings drawn around the avatar instead of in place of it, sampled from a second
 * engine so a working avatar keeps its silhouette (`orbit` as a state is not shape-safe).
 */
function AvatarRings(props: { when: boolean; children: JSX.Element }) {
  return (
    <Show when={props.when} fallback={props.children}>
      <OrbitRings>{props.children}</OrbitRings>
    </Show>
  );
}

function OrbitRings(props: { children: JSX.Element }) {
  let elapsed = POSES[RING_POSE];
  let ringsSeen = false;
  let anchor: SVGSVGElement | undefined;
  const engine = new BotEngine(RAYON, RING_POSE);
  const [arcs, setArcs] = createSignal<BotFrame["arcs"]>(engine.sample(elapsed).arcs, { equals: false });

  onSettled(() => {
    if (prefersReducedMotion()) return;
    // The rings run on the page's shared avatar clock: one requestAnimationFrame serves every
    // avatar's engine at once, and stops while the window is hidden or the row scrolled away.
    const step = (dt: number) => {
      elapsed += dt;
      let sampled = engine.sample(elapsed);
      // A pose plays once, and its rings fade out before it ends - orbit holds them for 3.6s of a
      // 4.3s block. So the pose restarts on the frame its rings run out, which is the engine's own
      // measure of the cycle rather than a duration restated here.
      if (ringsSeen && sampled.arcs.length === 0) {
        ringsSeen = false;
        engine.reset(RING_POSE, elapsed);
        sampled = engine.sample(elapsed);
      }
      ringsSeen ||= sampled.arcs.length > 0;
      setArcs(sampled.arcs);
    };
    let stop: (() => void) | null = null;
    const start = () => {
      if (stop) return;
      stop = subscribe(step, { fps: AVATAR_FPS, weight: 2 });
    };
    const close = () => {
      stop?.();
      stop = null;
    };
    // A `BloubBot` pauses itself off screen through its own observer. These rings are our loop, so
    // without the same gate every working row in a long sidebar keeps sampling an engine and
    // writing paths that nobody can see.
    const observer =
      anchor && window.IntersectionObserver
        ? new IntersectionObserver(([entry]) => {
            if (entry?.isIntersecting) start();
            else close();
          })
        : undefined;
    if (observer && anchor) observer.observe(anchor);
    else start();
    return () => {
      observer?.disconnect();
      close();
    };
  });

  return (
    <>
      <AvatarArcs arcs={arcs()} half="back" ref={(element) => (anchor = element)} />
      <AvatarArcs arcs={arcs()} half="front" />
      {props.children}
    </>
  );
}

function AvatarArcs(props: { arcs: BotFrame["arcs"]; half: "back" | "front"; ref?: (element: SVGSVGElement) => void }) {
  const gradientId = createUniqueId();
  return (
    <svg
      ref={props.ref}
      class="agent-avatar-arcs"
      viewBox={`${-DEMI_VIEWBOX} ${-DEMI_VIEWBOX} ${DEMI_VIEWBOX * 2} ${DEMI_VIEWBOX * 2}`}
      fill="none"
      stroke-linecap="round"
      aria-hidden="true"
    >
      <defs>
        <For each={props.arcs} keyed={false}>
          {(arc) => (
            <linearGradient
              id={`${gradientId}-${arc().id}`}
              gradientUnits="userSpaceOnUse"
              x1={arc().grad.x1}
              y1={arc().grad.y1}
              x2={arc().grad.x2}
              y2={arc().grad.y2}
            >
              <For each={arc().grad.stops} keyed={false}>
                {(stop, index) => (
                  <stop offset={index / Math.max(1, arc().grad.stops.length - 1)} stop-color={stop()} />
                )}
              </For>
            </linearGradient>
          )}
        </For>
      </defs>
      <For each={props.arcs} keyed={false}>
        {(arc) => (
          <path
            d={props.half === "back" ? arc().back : arc().front}
            stroke={`url(#${gradientId}-${arc().id})`}
            stroke-width={arc().width}
            opacity={arc().opacity}
          />
        )}
      </For>
    </svg>
  );
}

function GeneratedAvatar(props: {
  seed: string;
  hue: AvatarHue | null;
  motion: AvatarMotion;
  mood: AvatarMood;
  animationOffset?: number | undefined;
  shape?: SupportedAvatarSilhouetteId | undefined;
  expression?: ExpressionId | undefined;
  transition: PlushTransition;
  followPointer: boolean;
  renderCanvas: boolean;
  breathe?: string | undefined;
  class: string;
  style?: Record<string, string> | undefined;
}) {
  let element: HTMLSpanElement | undefined;
  const [interacting, setInteracting] = createSignal(false);
  const [reducedMotion, setReducedMotion] = createSignal(prefersReducedMotion());
  const plushMood = createMemo(() => PLUSH_MOODS[props.mood]);
  const profile = createMemo(() => bloubAvatarProfile(props.seed, props.hue));
  const restingExpression = () => props.expression ?? profile().expression;
  // A preview of a chosen shape or eyes keeps the face it shows, so the choice stays visible on hover.
  const hovered = () =>
    interacting() &&
    !reducedMotion() &&
    props.mood === "idle" &&
    props.shape === undefined &&
    props.expression === undefined;
  const [hoverFace, setHoverFace] = createSignal<HoverFace | null>(null);
  // The silhouette and the colour are identity and come only from the seed. The mood may lend the
  // face an expression; when it does not, the seeded one is the resting face, or the hover face.
  const appearance = createMemo(() => {
    const hover = hovered() ? hoverFace() : null;
    return {
      shape: props.shape ?? profile().shape,
      color: profile().color,
      expression: plushMood().expression ?? hover?.expression ?? restingExpression(),
      state: hover?.state ?? plushMood().state,
    };
  });
  // A mood that carries its own motion has to be seen without being pointed at, and so do eyes that
  // follow the pointer; the resting moods keep the hover gating that the perf note above is about.
  const animated = () => props.followPointer || plushMood().busy || !STATIC_MOTIONS.has(props.motion) || interacting();

  onSettled(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const syncReducedMotion = () => setReducedMotion(media?.matches ?? false);
    syncReducedMotion();
    media?.addEventListener?.("change", syncReducedMotion);

    // What must be hovered or focused for a resting avatar to move: the control the avatar sits in or
    // beside, marked with `data-avatar-hover` when the avatar is only a neighbour of it. A dialog and a
    // scroll region are focusable as well, and taking one of those would start every avatar on it at once.
    const group = element?.closest<HTMLElement>(`${HOVER_GROUP}, [tabindex]`);
    const interactionTarget = group?.matches(HOVER_GROUP) ? group : element;
    const startInteraction = () => {
      if (!interacting()) setHoverFace((previous) => randomHoverFace(previous, restingExpression()));
      setInteracting(true);
    };
    const stopInteraction = () => setInteracting(false);
    // Only keyboard focus starts the avatar. A click leaves the focus on the button it lands on, such as
    // the sidebar row of the open channel, and the window gives that button `focusin` again each time it
    // comes back to the front. No pointer is there to leave, so the avatar moved until the next click.
    const startFocusInteraction = (event: FocusEvent) => {
      if (event.target instanceof Element && event.target.matches(":focus-visible")) startInteraction();
    };
    const stopFocusInteraction = (event: FocusEvent) => {
      if (!(event.relatedTarget instanceof Node) || !interactionTarget?.contains(event.relatedTarget)) {
        stopInteraction();
      }
    };
    interactionTarget?.addEventListener("pointerenter", startInteraction);
    interactionTarget?.addEventListener("pointerleave", stopInteraction);
    interactionTarget?.addEventListener("focusin", startFocusInteraction);
    interactionTarget?.addEventListener("focusout", stopFocusInteraction);

    return () => {
      media?.removeEventListener?.("change", syncReducedMotion);
      interactionTarget?.removeEventListener("pointerenter", startInteraction);
      interactionTarget?.removeEventListener("pointerleave", stopInteraction);
      interactionTarget?.removeEventListener("focusin", startFocusInteraction);
      interactionTarget?.removeEventListener("focusout", stopFocusInteraction);
    };
  });

  createEffect(
    () => props.followPointer,
    (follow) => {
      if (follow && element) return gaze.attach(element);
    },
  );

  const FallbackFrozen = () => (
    <Show when={appearance()} keyed>
      {(frozen) => (
        <BloubBot
          size={100}
          shape={frozen.shape}
          color={frozen.color}
          expression={frozen.expression}
          state={frozen.state}
          frozenAt={POSES[frozen.state]}
          ariaLabel=""
          class="bloub-avatar-svg"
        />
      )}
    </Show>
  );

  /** The current SVG stands in while the canvas engine loads under the first paint and whenever it
      fails; it animates exactly as before so nothing looks frozen during the handover. */
  const fallbackForNow = () => (
    <Show when={animated()} fallback={<FallbackFrozen />}>
      <BloubBot
        size={100}
        shape={appearance().shape}
        color={appearance().color}
        expression={appearance().expression}
        cycle={motionCycle()}
        playing={true}
        fps={AVATAR_FPS}
        initialPhase={props.animationOffset ?? avatarAnimationPhase(props.seed)}
        gaze={gazeScript()}
        ariaLabel=""
        class="bloub-avatar-svg"
      />
    </Show>
  );

  const avatar = () =>
    props.renderCanvas !== false ? (
      <BotCanvasAvatar
        shape={appearance().shape}
        color={avatarHeadColor(props.seed, props.hue)}
        // The canvas states are the engine's own three; the mood folds onto them.
        state={
          props.mood === "asleep"
            ? "sleeping"
            : props.mood === "working" || props.mood === "connecting"
              ? "working"
              : "default"
        }
        motion={animated() ? "full" : "subtle"}
        // Subtle motion for resting avatars; full motion when busy/hovered/focused.
        playing={!reducedMotion()}
        interactive={props.followPointer}
        seed={props.seed}
        class="bloub-avatar-svg"
        fallback={fallbackForNow()}
      />
    ) : (
      fallbackForNow()
    );

  return (
    <span
      ref={element}
      class={`${props.class} agent-avatar-bloub`}
      style={props.style}
      data-avatar="generated"
      data-mood={props.mood}
      aria-hidden="true"
    >
      <AvatarRings when={presentation().rings}>{avatar()}</AvatarRings>
    </span>
  );
}

/** A hover face that differs from the resting eyes and from the face the last hover showed. */
function randomHoverFace(previous: HoverFace | null, resting: ExpressionId): HoverFace {
  const choices = HOVER_FACES.filter((face) => face !== previous && face.expression !== resting);
  return choices[Math.floor(Math.random() * choices.length)] ?? HOVER_WINK;
}

function avatarAnimationPhase(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) / 0x100000000) * 1.4;
}
