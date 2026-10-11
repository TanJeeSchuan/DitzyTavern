import { boxSeed } from "./seed";
import { raceBox } from "./race";
import { Value } from "@sinclair/typebox/value";
import type { GenerationJsonValue } from "../../shared/generation-json";
import { type BoxSetups, type PromptBoxReference } from "../../shared/contract/box";
import { hasEnabledMemorySlot, type PromptPresetSlot } from "../../shared/contract/prompt-preset";
import { memoryBox } from "./memory";
import type { MemoryRecallSnapshot } from "../memory/recall";
import { authorNoteBox } from "./author-note";
import type { RecordStates } from "./records";
import type { BoxMoves } from "../../shared/contract/box-generation";
import { worldClockBox } from "./world-clock";
import type { AdvanceInput, AdvanceResult, BlockItem, Box, BoxContext, BoxServices } from "./contract";

/** @approved What each Box with an enabled preset block contributes to one Generation. */
export type BoxItems = Partial<Record<PromptBoxReference, readonly (BlockItem & { readonly index: number })[]>>;

export type BoxResults = Partial<Record<PromptBoxReference, AdvanceResult<GenerationJsonValue, GenerationJsonValue>>>;

interface CapturedBox {
	readonly reference: PromptBoxReference;
	readonly fingerprint: string;
	run(services: BoxContext<keyof BoxServices>): Promise<AdvanceResult<GenerationJsonValue, GenerationJsonValue>>;
}
export type BoxInputs = readonly CapturedBox[];

const captureBox = <Setup, Dependencies, Trace extends GenerationJsonValue, Services extends keyof BoxServices, Rec extends GenerationJsonValue, State, Move>(
	reference: PromptBoxReference,
	box: Box<Setup, Dependencies, Trace, Services, Rec, State, Move>,
	input: AdvanceInput<Setup, Dependencies, State, Move>,
): CapturedBox => ({
	reference,
	fingerprint: JSON.stringify({ setup: input.setup, state: input.state, moves: input.moves, dependencies: box.advance?.fingerprint?.(input) }),
	run: async (services) => {
		// @approved
		// SAFETY: The entries are exactly the services this Box declared in inject.
		const injected = Object.fromEntries((box.inject ?? []).map((key) => [key, services[key]])) as Pick<BoxServices, Services>;
		const result = await box.advance?.run(input, { ...injected, signal: services.signal }) ?? { items: [] };
		if (result.record !== undefined) {
			if (box.records === undefined) throw new Error(`${reference} returned a record without declaring records.`);
			Value.Assert(box.records.schema, result.record);
		}
		if (result.trace !== undefined && box.advance?.trace !== undefined) Value.Assert(box.advance.trace, result.trace);
		return result;
	},
});

export const captureBoxes = (slots: readonly PromptPresetSlot[], setups: BoxSetups, memory: MemoryRecallSnapshot, states: RecordStates, generation: { seed: string; intent: "respond" | "continue"; moves: BoxMoves; withdrawn: readonly string[] }): BoxInputs => {
	const capturedMemory = captureBox("box:memory", memoryBox, { setup: undefined, dependencies: memory, state: undefined, moves: [] });
	const enabled = (reference: PromptBoxReference) => slots.some((slot) => slot.enabled && slot.reference === reference);
	// @approved
	// Disabled Memory still exposes captured activation evidence in inspection, without running advance.
	if (!hasEnabledMemorySlot(slots)) capturedMemory.run = async () => ({ items: [], trace: memory.activation });
	return [
		...enabled("box:race") ? [captureBox("box:race", raceBox, { setup: setups.race, state: states.race, moves: generation.moves.race ?? [], dependencies: { seed: boxSeed(generation.seed, "race"), intent: generation.intent, withdrawn: generation.withdrawn } })] : [],
		...enabled("box:author-note") ? [captureBox("box:author-note", authorNoteBox, { setup: setups["author-note"], dependencies: undefined, state: undefined, moves: [] })] : [],
		capturedMemory,
		...enabled("box:world-clock") && setups["world-clock"].enabled
			? [captureBox("box:world-clock", worldClockBox, { setup: setups["world-clock"], dependencies: undefined, state: states["world-clock"], moves: [] })]
			: [],
	];
};

export const fingerprintBoxes = (inputs: BoxInputs): string => JSON.stringify(inputs.map(({ reference, fingerprint }) => [reference, fingerprint]));

export const advanceBoxes = async (inputs: BoxInputs, services: BoxContext<keyof BoxServices>): Promise<BoxResults> =>
	Object.fromEntries(await Promise.all(inputs.map(async (box) => [box.reference, await box.run(services)])));
