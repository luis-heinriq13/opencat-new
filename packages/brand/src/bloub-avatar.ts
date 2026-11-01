import {
  COLOR_BY_ID,
  type ColorId,
  EXPRESSIONS,
  type ExpressionId,
  SHAPE_BY_ID,
  SHAPES,
  type ShapeId,
} from "@norbert_bodziony/bloub";
import type { AvatarHue } from "@openbot/contracts/ipc";
import { EXTRA_SILHOUETTE_IDS, EXTRA_SILHOUETTE_RADII, type ExtraSilhouetteId } from "./bloub-extra-shapes";

export type BuiltInAvatarSilhouetteId = Exclude<ShapeId, "goutte">;
export type SupportedAvatarSilhouetteId = BuiltInAvatarSilhouetteId | ExtraSilhouetteId;
export { EXTRA_SILHOUETTE_IDS, type ExtraSilhouetteId };

// The engine reads only `radii` of an entry and looks it up by string, so an extra silhouette is one
// more entry in the same map. `SHAPES` stays the released list: a seed picks its shape by index in it,
// and a longer list would change the look of every stored avatar.
for (const id of EXTRA_SILHOUETTE_IDS) {
  SHAPE_BY_ID.set(id, { id: "cercle", radii: [...EXTRA_SILHOUETTE_RADII[id]] });
}

const SHAPE_TAG = ":shape-";

export interface BloubAvatarProfile {
  shape: SupportedAvatarSilhouetteId;
  color: ColorId;
  expression: ExpressionId;
}

const AUTOMATIC_COLORS = ["rouge", "orange", "ambre", "vert", "turquoise", "bleu", "violet", "rose"] as const;
const UNSUPPORTED_AVATAR_SILHOUETTE = "goutte" as const satisfies ShapeId;
const SUPPORTED_AVATAR_SILHOUETTES = SHAPES.map((option) => option.id).filter(
  (silhouette): silhouette is BuiltInAvatarSilhouetteId => silhouette !== UNSUPPORTED_AVATAR_SILHOUETTE,
);

/** A seed that names an extra silhouette ends with `:shape-<id>` (the seed pattern allows only a-z, 0-9, ":" and "-"). Every older seed has no tag. */
export function avatarSeedWithExtraShape(seed: string, shape: ExtraSilhouetteId): string {
  return `${seed}${SHAPE_TAG}${shape}`;
}

function taggedExtraShape(seed: string): ExtraSilhouetteId | undefined {
  const at = seed.lastIndexOf(SHAPE_TAG);
  if (at < 0) return undefined;
  const id = seed.slice(at + SHAPE_TAG.length);
  return EXTRA_SILHOUETTE_IDS.find((candidate) => candidate === id);
}

const HUE_COLORS: Readonly<Record<AvatarHue, ColorId>> = {
  0: "rouge",
  30: "orange",
  55: "ambre",
  100: "vert",
  150: "vert",
  185: "turquoise",
  215: "bleu",
  245: "violet",
  280: "violet",
  320: "rose",
};

export const AVATAR_HUE_OPTIONS: ReadonlyArray<{
  hue: AvatarHue;
  label: string;
}> = [
  { hue: 0, label: "Red" },
  { hue: 30, label: "Orange" },
  { hue: 55, label: "Yellow" },
  { hue: 100, label: "Lime" },
  { hue: 150, label: "Green" },
  { hue: 185, label: "Cyan" },
  { hue: 215, label: "Blue" },
  { hue: 245, label: "Indigo" },
  { hue: 280, label: "Violet" },
  { hue: 320, label: "Magenta" },
];

// Hues 100 and 280 stay valid for stored agents, but draw the same color as 150 and 245.
export const AVATAR_HUE_CHOICES = AVATAR_HUE_OPTIONS.filter((option) => option.hue !== 100 && option.hue !== 280);

export function bloubAvatarProfile(seed: string, hue: AvatarHue | null): BloubAvatarProfile {
  const storedSilhouette = requiredItem(SHAPES, stableIndex(`${seed}:shape`, SHAPES.length)).id;
  const silhouette =
    storedSilhouette === UNSUPPORTED_AVATAR_SILHOUETTE
      ? requiredItem(
          SUPPORTED_AVATAR_SILHOUETTES,
          stableIndex(`${seed}:shape:replacement`, SUPPORTED_AVATAR_SILHOUETTES.length),
        )
      : storedSilhouette;
  const expression = requiredItem(EXPRESSIONS, stableIndex(`${seed}:expression`, EXPRESSIONS.length)).id;

  return {
    shape: taggedExtraShape(seed) ?? silhouette,
    expression,
    color:
      hue === null
        ? requiredItem(AUTOMATIC_COLORS, stableIndex(`${seed}:color`, AUTOMATIC_COLORS.length))
        : HUE_COLORS[hue],
  };
}

export function avatarHueSwatch(hue: AvatarHue): string {
  return colorHex(HUE_COLORS[hue]);
}

export function avatarHeadColor(seed: string, hue: AvatarHue | null): string {
  return colorHex(bloubAvatarProfile(seed, hue).color);
}

export function avatarCandidateSeeds(agentId: string, currentSeed: string, batch: number): string[] {
  const candidates = [currentSeed];
  const firstProfile = bloubAvatarProfile(currentSeed, null);
  const unseenSilhouetteIds = new Set<SupportedAvatarSilhouetteId>(SUPPORTED_AVATAR_SILHOUETTES);
  const usedExpressions = new Set<ExpressionId>([firstProfile.expression]);
  unseenSilhouetteIds.delete(firstProfile.shape);
  let index = 1;

  while (unseenSilhouetteIds.size > 0) {
    const candidate = `${agentId}:avatar:${batch}:${index}`;
    index += 1;
    if (candidates.includes(candidate)) continue;
    const profile = bloubAvatarProfile(candidate, null);
    if (!unseenSilhouetteIds.delete(profile.shape)) continue;
    candidates.push(candidate);
    usedExpressions.add(profile.expression);
  }

  // One candidate for each extra silhouette, after the released ones.
  for (const shape of EXTRA_SILHOUETTE_IDS) {
    if (firstProfile.shape === shape) continue;
    candidates.push(avatarSeedWithExtraShape(`${agentId}:avatar:${batch}:${shape}`, shape));
  }

  while (candidates.length < 12) {
    const candidate = `${agentId}:avatar:${batch}:${index}`;
    index += 1;
    if (candidates.includes(candidate)) continue;
    const profile = bloubAvatarProfile(candidate, null);
    if (usedExpressions.has(profile.expression)) continue;
    candidates.push(candidate);
    usedExpressions.add(profile.expression);
  }

  return candidates;
}

function stableIndex(value: string, length: number): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % length;
}

function colorHex(color: ColorId): string {
  const value = COLOR_BY_ID.get(color)?.hex;
  if (!value) throw new Error(`Bloub did not return a color for ${color}.`);
  return value;
}

function requiredItem<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error("Bloub avatar options are empty.");
  return item;
}
