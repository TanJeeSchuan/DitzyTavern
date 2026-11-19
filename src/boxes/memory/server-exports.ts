import type { Database } from "bun:sqlite";
import { effectiveRecord, type ExportsOf } from "@/box-sdk/server";
import descriptor from "./shared-descriptor";
import type { MemorySelectedClaims, MemoryPeople } from "./contract";
import { readMemoryLabelState } from "./server-chat";
import { readMemorySources } from "./server-memories";
import { applyMemoryPeople } from "./shared";

// @approved
//  The effective Claims on the Selected narrative path, each with the Message
// that holds it and its people resolved under the Chat's Cast labels: the
// selected sources the Memories panel lists, so an unselected Variant's
// records and an author who is not in the story are left out, and a Writer
// override wins.
const readSelectedPathClaims = (database: Database, conversationId: number): MemorySelectedClaims => {
	const labels = readMemoryLabelState(database, conversationId);
	return readMemorySources(database, conversationId, labels, "selected").flatMap(({ messageId, slot }) => (effectiveRecord(slot)?.claims ?? []).map((claim) => ({
		messageId,
		claim: claim.claim,
		attribution: claim.attribution,
		people: applyMemoryPeople(claim.people, labels.cast, labels.identities, labels.merges),
		evidence: claim.evidence,
	})));
};

/** @approved The `people` Export: each person label on the Selected narrative path, in first-appearance order, after the Chat's label merges. */
export const readMemoryPeople = (database: Database, conversationId: number): MemoryPeople => {
	const people = new Set<string>();
	for (const claim of readSelectedPathClaims(database, conversationId)) for (const person of claim.people) people.add(person);
	return [...people];
};

// @approved
//  Memory's Exports, as another Box's route handler reaches them through the
// `exportsOf` its routes receive: synchronous answers from one Chat, never
// from a Generation. `ExportsOf` types each one from the schemas the
// descriptor declares, so inputs and answers have the one home.
export const memoryExports: ExportsOf<typeof descriptor.exports> = {
	people: (_, { database, conversationId }) => readMemoryPeople(database, conversationId),
	selectedClaims: (_, { database, conversationId }) => readSelectedPathClaims(database, conversationId),
};
