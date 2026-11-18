import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { effectiveRecord, readBoxLifecycles, readChatVariants, readRecordSlots, type BoxExportContext } from "@/box-sdk/server";
import { memoryRecord, type MemoryClaimsAbout, type MemoryClaimsAboutInput, type MemoryPeople } from "./contract";
import { isExcludedAuthor, readMemoryLabelState } from "./server-chat";
import { applyMemoryPeople } from "./shared";

// @approved
//  The effective Claims on the Selected narrative path, each with the Message
// that holds it and its people resolved under the Chat's Cast labels: the
// same effective records the Memories panel lists — only the Selected
// Variants, a nonempty passage each — so an unselected Variant's records and
// an author who is not in the story are left out, and a Writer override
// wins.
const readSelectedPathClaims = (database: Database, conversationId: number) => {
	const labels = readMemoryLabelState(database, conversationId);
	const variants = readChatVariants(database, conversationId)
		.filter(({ selected, authorParticipantId }) => selected && !isExcludedAuthor(labels, authorParticipantId));
	const db = drizzle(database);
	const slots = readRecordSlots(db, "memory", memoryRecord, readBoxLifecycles(db, conversationId).memory?.instance, variants.map(({ variantId }) => variantId));
	const claims = variants.flatMap(({ messageId, variantId, content }) => content.trim() === "" ? [] : (effectiveRecord(slots.get(variantId))?.claims ?? []).map((claim) => ({
		messageId,
		claim: claim.claim,
		attribution: claim.attribution,
		people: applyMemoryPeople(claim.people, labels.cast, labels.identities, labels.merges),
		evidence: claim.evidence,
	})));
	return claims;
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
//  Memory's Exports, as another Box's route handler reaches them through
// `boxExports`: synchronous answers from one Chat, never from a Generation.
export const memoryExports = {
	people: (_: undefined, { database, conversationId }: BoxExportContext) => readMemoryPeople(database, conversationId),
	claimsAbout: (input: MemoryClaimsAboutInput, { database, conversationId }: BoxExportContext) => readMemoryClaimsAbout(database, conversationId, input.label),
};
