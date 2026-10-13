import { boxSeed } from "./seed";
import { raceBox } from "../../boxes/race/server";
import { Value } from "@sinclair/typebox/value";
import type { GenerationJsonValue } from "../../shared/generation-json";
import { boxDescriptor, boxDescriptors, boxReference, type BoxDescriptor, type BoxId, type BoxSetups, type BoxStates, type PromptBoxReference } from "../../shared/contract/box";
import type { PromptPresetSlot } from "../../shared/contract/prompt-preset";
import type { BoxValue } from "../../shared/contract/box-value";
import type { Database } from "bun:sqlite";
import { memoryBox } from "../../boxes/memory/server";
import { memoryRoutes } from "../../boxes/memory/server-routes";
import { authorNoteBox } from "../../boxes/author-note/server";
import type { RecordStates } from "./records";
import type { BoxMoves } from "../../shared/contract/box-generation";
import { worldClockBox } from "../../boxes/world-clock/server";
import { phoneBox } from "../../boxes/phone/server";
import { thoughtBox } from "../../boxes/thought/server";
import { moodBox } from "../../boxes/mood/server";
import type { AdvanceInput, AdvanceResult, BlockItem, BoxContext, BoxServices, CaptureRead, HostBox } from "./contract";
import { resolveDecisionOf, type BoxDecision } from "./services";

// @approved
//  The descriptor decides which hooks a Box must declare: records for a
// `record` schema, a digest for a `decision`, and a render for `moves`. A
// digesting Box's window read is the host's passage timeline, so it declares
// no `read`; only that read calls `status`, so no other Box declares one.
// Ids are known only at runtime, so the registry checks this when it is built.
const checkedHooks = (id: BoxId, descriptor: BoxDescriptor, box: HostBox | undefined): HostBox => {
	if (box === undefined) throw new Error(`The ${id} Box has no server module.`);
	const broken = ([
		[(descriptor.record === undefined) === (box.records === undefined), "records exactly when it declares a record"],
		[(descriptor.decision === undefined) === (box.records?.digest === undefined), "a digest exactly when it declares a decision"],
		[(descriptor.moves === undefined) === (box.moves === undefined), "a Move render exactly when it declares Moves"],
		[descriptor.decision === undefined || box.read === undefined, "no read, since it digests"],
		[descriptor.decision !== undefined || box.status === undefined, "no status, since it does not digest"],
	] as const).flatMap(([holds, rule]) => holds ? [] : [rule]);
	if (broken.length > 0) throw new Error(`The ${id} Box must declare ${broken.join("; ")}.`);
	return box;
};

const register = (): ReadonlyMap<BoxId, HostBox> => {
	const modules = new Map<BoxId, HostBox>(Object.entries({
		"author-note": authorNoteBox, memory: memoryBox, "world-clock": worldClockBox, race: raceBox, phone: phoneBox, thought: thoughtBox, mood: moodBox,
	}));
	return new Map([...boxDescriptors].map(([id, descriptor]) => [id, checkedHooks(id, descriptor, modules.get(id))]));
};
let registered: ReadonlyMap<BoxId, HostBox> | undefined;
// @approved
//  The server module of every registered Box, by id, in registry order. A
// lookup rather than a table, because Box modules read through the
// Conversation module, which reads Box setups through here: a table would be
// built before the Boxes it holds. Each Box types its own hooks with
// `satisfies Box<…>`; the host holds it as a HostBox and checks each value it
// routes against the Box's descriptor.
export const serverBoxes = (): ReadonlyMap<BoxId, HostBox> => registered ??= register();
/** @approved A registered Box's server module; an unknown id has none. */
export const serverBox = (id: BoxId): HostBox | undefined => serverBoxes().get(id);

/** @approved What each Box with an enabled preset block contributes to one Generation. */
export type BoxItems = Record<PromptBoxReference, readonly (BlockItem & { readonly index: number })[] | undefined>;

export type BoxResults = Readonly<Record<PromptBoxReference, AdvanceResult<GenerationJsonValue, GenerationJsonValue> | undefined>>;

interface CapturedBox {
	readonly reference: PromptBoxReference;
	readonly fingerprint: string;
	run(services: BoxServicesOf): Promise<AdvanceResult<GenerationJsonValue, GenerationJsonValue>>;
}
export type BoxInputs = readonly CapturedBox[];
/** @approved The host services for each Box, as `boxServices` builds them. */
type BoxServicesOf = (id: BoxId, decision: BoxDecision) => BoxContext<keyof BoxServices>;

/** @approved The services a Box declared in `inject`, and the signal. */
export const injectServices = (box: HostBox, services: BoxContext<keyof BoxServices>): BoxContext<keyof BoxServices> => {
	// @approved
	// SAFETY: The entries are exactly the services this Box declared in inject.
	const injected = Object.fromEntries((box.inject ?? []).map((key) => [key, services[key]])) as Pick<BoxServices, keyof BoxServices>;
	return { ...injected, signal: services.signal };
};

// @approved
//  The Decision Model selection is resolved with the rest of the capture and
// kept in `run`'s closure, so its credential never reaches the capture's
// serialized fields.
const captureBox = (id: BoxId, box: HostBox, input: AdvanceInput<BoxValue, unknown, unknown, unknown>, decision: BoxDecision): CapturedBox => ({
	reference: boxReference(id),
	fingerprint: JSON.stringify({ setup: input.setup, state: input.state, moves: input.moves, dependencies: box.advance?.fingerprint?.(input) ?? input.dependencies }),
	run: async (services) => {
		const result = await box.advance?.run(input, injectServices(box, services(id, decision))) ?? { items: [] };
		if (result.record !== undefined) {
			const { record } = boxDescriptor(id);
			if (record === undefined) throw new Error(`${boxReference(id)} returned a record without declaring records.`);
			Value.Assert(record, result.record);
		}
		if (result.trace !== undefined && box.advance?.trace !== undefined) Value.Assert(box.advance.trace, result.trace);
		return result;
	},
});

// @approved
//  The preset decides where a Box goes; the Chat decides whether it runs. A
// Box is captured only while it is enabled and its block is.
export const captureBoxes = (slots: readonly PromptPresetSlot[], setups: BoxSetups, boxes: BoxStates, states: RecordStates, moves: BoxMoves, read: CaptureRead): BoxInputs =>
	[...serverBoxes()].flatMap(([id, box]) => {
		if (boxes[id] !== "enabled" || !slots.some((slot) => slot.enabled && slot.reference === boxReference(id))) return [];
		const setup = setups[id];
		const dependencies = box.dependencies?.({ ...read, seed: boxSeed(read.seed, id) }, setup);
		return [captureBox(id, box, { setup, state: states[id], moves: moves[id] ?? [], dependencies }, resolveDecisionOf(read.database, id))];
	});

// @approved
//  Routes a Box serves beside the contract's: Memory's, for its in-tree side
// panel, settings editor and trace view, until that UI moves into its Box.
export const boxRoutes = (database: Database) => memoryRoutes(database);

export const fingerprintBoxes = (inputs: BoxInputs): string => JSON.stringify(inputs.map(({ reference, fingerprint }) => [reference, fingerprint]));

export const advanceBoxes = async (inputs: BoxInputs, services: BoxServicesOf): Promise<BoxResults> =>
	Object.fromEntries(await Promise.all(inputs.map(async (box) => [box.reference, await box.run(services)])));
