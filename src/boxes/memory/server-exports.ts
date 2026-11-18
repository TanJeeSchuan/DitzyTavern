import type { Database } from "bun:sqlite";
import { effectiveRecord, type ExportsOf } from "@/box-sdk/server";
import descriptor from "./shared-descriptor";
import type { MemoryClaimsAbout, MemoryPeople } from "./contract";
import { readMemoryLabelState } from "./server-chat";
import { readMemorySources } from "./server-memories";
import { applyMemoryPeople } from "./shared";

// @approved
//  The effective Claims on the Selected narrative path, each with the Message
// that holds it and its people resolved under the Chat's Cast labels: the
// selected sources the Memories panel lists, so an unselected Variant's
// records and an author who is not in the story are left out, and a Writer
// override wins.
const readSelectedPathClaims = (database: Database, conversationId: number) => {
	const labels = readMemoryLabelState(database, conversationId);
	return readMemorySources(database, conversationId, labels).filter(({ selected }) => selected).flatMap(({ messageId, slot }) => (effectiveRecord(slot)?.claims ?? []).map((claim) => ({
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

/** @approved The `claimsAbout` Export: the effective Claims on the Selected narrative path whose people include the label, in path order. */
export const readMemoryClaimsAbout = (database: Database, conversationId: number, label: string): MemoryClaimsAbout =>
	readSelectedPathClaims(database, conversationId).filter(({ people }) => people.includes(label));

// @approved
//  Memory's Exports, as another Box's route handler reaches them through the
// `exportsOf` its routes receive: synchronous answers from one Chat, never
// from a Generation. `ExportsOf` types each one from the schemas the
// descriptor declares, so inputs and answers have the one home.
export const memoryExports: ExportsOf<typeof descriptor.exports> = {
	people: (_, { database, conversationId }) => readMemoryPeople(database, conversationId),
	claimsAbout: (input, { database, conversationId }) => readMemoryClaimsAbout(database, conversationId, input.label),
};
