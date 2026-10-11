import { createHash } from "node:crypto";
import type { BoxId } from "../../shared/contract/box";

// @approved
//  One Generation seed per Variant, shared by every Box. A Variant without
// one, such as an imported or human-written one, falls back to its id.
export const SEED_NAMESPACE = "box";
export const SEED_KEY = "seed";

export const newVariantSeed = (): string => crypto.randomUUID();
export const variantSeedOf = (stored: string | undefined, variantId: number): string => stored ?? `variant:${variantId}`;

/** @approved Each Box draws from its own stream of the Variant's seed. */
export const boxSeed = (variantSeed: string, box: BoxId): string =>
	createHash("sha256").update(`${variantSeed}\u0000${box}`).digest("hex");

export const seededFraction = (seed: string): number =>
	createHash("sha256").update(seed).digest().readUInt32BE(0) / 2 ** 32;
