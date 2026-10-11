import { boxSeed } from "./seed";
import { raceBox } from "./race";
import { Value } from "@sinclair/typebox/value";
import type { GenerationJsonValue } from "../../shared/generation-json";
import {
	boxDescriptors, boxIds, boxReference,
	type BoxId, type BoxSetups, type BoxStates, type DigestBoxId, type MoveBoxId, type PromptBoxReference, type RecordBoxId,
} from "../../shared/contract/box";
import type { PromptPresetSlot } from "../../shared/contract/prompt-preset";
import { memoryBox } from "./memory";
import { authorNoteBox } from "./author-note";
import type { RecordStates } from "./records";
import type { BoxMoves } from "../../shared/contract/box-generation";
import { worldClockBox } from "./world-clock";
import { phoneBox } from "./phone";
import { thoughtBox } from "./thought";
import type { AdvanceInput, AdvanceResult, BlockItem, BoxContext, BoxServices, CaptureRead, HostBox } from "./contract";

// @approved
//  The server module of every Box. A lookup rather than a table, because Box
// modules read through the Conversation module, which reads Box setups
// through here: a table would be built before the Boxes it holds. The
// descriptor decides which hooks a Box must declare: records for a `record`
// schema, a digest for a `decision`, and a render for `moves`. A digesting
// Box's window read is the host's passage timeline, so it declares no `read`;
// only that read calls `status`, so no other Box declares one.
export const serverBox = <Id extends BoxId>(id: Id): ServerBoxes[Id] => {
	const boxes: ServerBoxes = { "author-note": authorNoteBox, memory: memoryBox, "world-clock": worldClockBox, race: raceBox, phone: phoneBox, thought: thoughtBox };
	return boxes[id];
};

type Records = NonNullable<HostBox["records"]>;
type ServerBoxes = { readonly [Id in BoxId]: HostBox
	& (Id extends RecordBoxId ? { readonly records: Records } : { readonly records?: never })
	& (Id extends DigestBoxId ? { readonly records: { readonly digest: NonNullable<Records["digest"]> }; readonly read?: never } : { readonly status?: never })
	& (Id extends MoveBoxId ? { readonly moves: NonNullable<HostBox["moves"]> } : { readonly moves?: never }) };

/** @approved What each Box with an enabled preset block contributes to one Generation. */
export type BoxItems = Partial<Record<PromptBoxReference, readonly (BlockItem & { readonly index: number })[]>>;

export type BoxResults = Partial<Record<PromptBoxReference, AdvanceResult<GenerationJsonValue, GenerationJsonValue>>>;

interface CapturedBox {
	readonly reference: PromptBoxReference;
	readonly fingerprint: string;
	run(services: BoxContext<keyof BoxServices>): Promise<AdvanceResult<GenerationJsonValue, GenerationJsonValue>>;
}
export type BoxInputs = readonly CapturedBox[];

const captureBox = (id: BoxId, box: HostBox, input: AdvanceInput<unknown, unknown, unknown, unknown>, blockEnabled: boolean): CapturedBox => ({
	reference: boxReference(id),
	fingerprint: JSON.stringify({ setup: input.setup, state: input.state, moves: input.moves, dependencies: box.advance?.fingerprint?.(input) }),
	run: async (services) => {
		// @approved
		// SAFETY: The entries are exactly the services this Box declared in inject.
		const injected = Object.fromEntries((box.inject ?? []).map((key) => [key, services[key]])) as Pick<BoxServices, keyof BoxServices>;
		const withoutBlock = box.advance?.withoutBlock;
		const result = !blockEnabled && withoutBlock !== undefined ? withoutBlock(input) : await box.advance?.run(input, { ...injected, signal: services.signal }) ?? { items: [] };
		if (result.record !== undefined) {
			const descriptor = boxDescriptors[id];
			if (!("record" in descriptor)) throw new Error(`${boxReference(id)} returned a record without declaring records.`);
			Value.Assert(descriptor.record, result.record);
		}
		if (result.trace !== undefined && box.advance?.trace !== undefined) Value.Assert(box.advance.trace, result.trace);
		return result;
	},
});

// @approved
//  The preset decides where a Box goes; the Chat decides whether it runs. A
// Box that declares `advance.withoutBlock` is captured without its block.
export const captureBoxes = (slots: readonly PromptPresetSlot[], setups: BoxSetups, boxes: BoxStates, states: RecordStates, moves: BoxMoves, read: CaptureRead): BoxInputs => {
	const setupOf: Partial<Record<BoxId, BoxSetups[keyof BoxSetups]>> = setups;
	const stateOf: { readonly [Id in BoxId]?: RecordStates[RecordBoxId] } = states;
	const movesOf: Partial<Record<BoxId, BoxMoves[keyof BoxMoves]>> = moves;
	return boxIds.flatMap((id) => {
		const box = serverBox(id);
		const blockEnabled = slots.some((slot) => slot.enabled && slot.reference === boxReference(id));
		if (boxes[id] !== "enabled" || (!blockEnabled && box.advance?.withoutBlock === undefined)) return [];
		const setup = setupOf[id];
		const dependencies = box.dependencies?.({ ...read, seed: boxSeed(read.seed, id) }, setup);
		return [captureBox(id, box, { setup, state: stateOf[id], moves: movesOf[id] ?? [], dependencies }, blockEnabled)];
	});
};

export const fingerprintBoxes = (inputs: BoxInputs): string => JSON.stringify(inputs.map(({ reference, fingerprint }) => [reference, fingerprint]));

export const advanceBoxes = async (inputs: BoxInputs, services: BoxContext<keyof BoxServices>): Promise<BoxResults> =>
	Object.fromEntries(await Promise.all(inputs.map(async (box) => [box.reference, await box.run(services)])));
