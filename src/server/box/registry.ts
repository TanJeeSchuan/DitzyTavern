import { boxSeed } from "./seed";
import { raceBox } from "../../boxes/race/server";
import { Value } from "@sinclair/typebox/value";
import type { GenerationJsonValue } from "../../shared/generation-json";
import {
	boxDescriptors, boxIds, boxReference,
	type BoxId, type BoxSetups, type BoxStates, type DigestBoxId, type MoveBoxId, type PromptBoxReference, type RecordBoxId, type SetupBoxId,
} from "../../shared/contract/box";
import type { PromptPresetSlot } from "../../shared/contract/prompt-preset";
import { memoryBox } from "../../boxes/memory/server";
import { authorNoteBox } from "../../boxes/author-note/server";
import type { RecordStates } from "./records";
import type { BoxMoves, BoxRecord } from "../../shared/contract/box-generation";
import { worldClockBox } from "../../boxes/world-clock/server";
import { phoneBox } from "../../boxes/phone/server";
import { thoughtBox } from "../../boxes/thought/server";
import { moodBox } from "../../boxes/mood/server";
import type { AdvanceInput, AdvanceResult, BlockItem, Box, BoxContext, BoxServices, CaptureRead, HostBox } from "./contract";

// @approved
//  The server module of every Box. A lookup rather than a table, because Box
// modules read through the Conversation module, which reads Box setups
// through here: a table would be built before the Boxes it holds. Each entry
// is checked against its own id's descriptor, and erased to a HostBox only
// when the host dispatches over ids.
export const serverBox = <Id extends BoxId>(id: Id): ServerBoxes[Id] => {
	const boxes = {
		"author-note": authorNoteBox, memory: memoryBox, "world-clock": worldClockBox, race: raceBox, phone: phoneBox, thought: thoughtBox, mood: moodBox,
	} satisfies { readonly [Id in BoxId]: BoxRegistration<Id> };
	const erased: ServerBoxes = boxes;
	return erased[id];
};

// @approved
//  The descriptor decides which hooks a Box must declare: records for a
// `record` schema, a digest for a `decision`, and a render for `moves`. A
// digesting Box's window read is the host's passage timeline, so it declares
// no `read`; only that read calls `status`, so no other Box declares one.
type Hooks<Id extends BoxId, B extends { readonly records?: { readonly digest?: unknown }; readonly moves?: unknown }> = B
	& (Id extends RecordBoxId ? { readonly records: NonNullable<B["records"]> } : { readonly records?: never })
	& (Id extends DigestBoxId ? { readonly records: { readonly digest: NonNullable<NonNullable<B["records"]>["digest"]> }; readonly read?: never } : { readonly status?: never })
	& (Id extends MoveBoxId ? { readonly moves: NonNullable<B["moves"]> } : { readonly moves?: never });

type SetupOf<Id extends BoxId> = Id extends SetupBoxId ? BoxSetups[Id] : undefined;
type RecordOf<Id extends BoxId> = Id extends RecordBoxId ? BoxRecord<Id> : never;
type MoveOf<Id extends BoxId> = Id extends MoveBoxId ? NonNullable<BoxMoves[Id]>[number] : never;
/** @approved A Box registered as `Id`: its setup, record and Move types are the ones that id's descriptor declares. */
export type BoxRegistration<Id extends BoxId> = Hooks<Id, Box<SetupOf<Id>, unknown, GenerationJsonValue, keyof BoxServices, RecordOf<Id>, unknown, MoveOf<Id>>>;
type ServerBoxes = { readonly [Id in BoxId]: Hooks<Id, HostBox> };

/** @approved What each Box with an enabled preset block contributes to one Generation. */
export type BoxItems = Partial<Record<PromptBoxReference, readonly (BlockItem & { readonly index: number })[]>>;

export type BoxResults = Partial<Record<PromptBoxReference, AdvanceResult<GenerationJsonValue, GenerationJsonValue>>>;

interface CapturedBox {
	readonly reference: PromptBoxReference;
	readonly fingerprint: string;
	run(services: BoxContext<keyof BoxServices>): Promise<AdvanceResult<GenerationJsonValue, GenerationJsonValue>>;
}
export type BoxInputs = readonly CapturedBox[];

/** @approved The services a Box declared in `inject`, and the signal. */
export const injectServices = (box: HostBox, services: BoxContext<keyof BoxServices>): BoxContext<keyof BoxServices> => {
	// @approved
	// SAFETY: The entries are exactly the services this Box declared in inject.
	const injected = Object.fromEntries((box.inject ?? []).map((key) => [key, services[key]])) as Pick<BoxServices, keyof BoxServices>;
	return { ...injected, signal: services.signal };
};

const captureBox = (id: BoxId, box: HostBox, input: AdvanceInput<unknown, unknown, unknown, unknown>, blockEnabled: boolean): CapturedBox => ({
	reference: boxReference(id),
	fingerprint: JSON.stringify({ setup: input.setup, state: input.state, moves: input.moves, dependencies: box.advance?.fingerprint?.(input) ?? input.dependencies }),
	run: async (services) => {
		const withoutBlock = box.advance?.withoutBlock;
		const result = !blockEnabled && withoutBlock !== undefined ? withoutBlock(input) : await box.advance?.run(input, injectServices(box, services)) ?? { items: [] };
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
