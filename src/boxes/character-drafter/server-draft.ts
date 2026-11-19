import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { TypeGuard, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
	codeAgentUnavailable, conversationExists, readBoxLifecycles, readChatVariants, readParticipants, runCodeAgent, type BoxExports, type CodeAgentActivity, type CodeAgentGlobal,
} from "@/box-sdk/server";
import { parseImageReferences, stripThoughts } from "@/box-sdk/shared";
import descriptor from "./shared-descriptor";
import { characterDraft, draftCast, draftClaimPeople, draftMemory, draftMessages, draftPeople } from "./contract";
import type { CharacterDraft, DraftCast, DraftMessages, DraftRequest, DrafterRead } from "./contract";

/** @approved The Selected narrative path as the agent reads it, a settled Variant per Message. */
export const readDraftMessages = (database: Database, conversationId: number): DraftMessages =>
	readChatVariants(database, conversationId, { selectedOrVariantIds: [] })
		.map(({ messageId, speaker, authorParticipantId, content }, index) => ({ id: messageId, index, author: speaker, authorParticipantId, text: content }));

const readDraftCast = (database: Database, conversationId: number, messages: DraftMessages): DraftCast =>
	readParticipants(database, conversationId).filter(({ removed }) => !removed).map(({ id, name }) => ({
		id, names: [...new Set([name, ...messages.flatMap(({ author, authorParticipantId }) => authorParticipantId === id && author !== null ? [author] : [])])],
	}));

// @approved
//  Why the draft is refused, or undefined: every quote is copied word for
// word from a Message on the path, outside its unspoken thoughts, and every
// line of `exampleDialogue` is one of the quotes, so the person's voice is
// never invented. Who speaks a quote is the agent's judgement.
export const draftRefusal = (messages: DraftMessages, draft: CharacterDraft): string | undefined => {
	if (parseImageReferences(draft.prompt.appearance).length > 0) return "Appearance must be text only. Remove the Image References.";
	const texts = new Map(messages.map(({ id, text }) => [id, text]));
	for (const quote of draft.quotes) {
		const text = texts.get(quote.messageId);
		if (text === undefined) return `Message ${quote.messageId} is not on the story's path.`;
		if (!text.includes(quote.text)) return `The quote "${quote.text}" is not in Message ${quote.messageId} word for word.`;
		if (!stripThoughts(text).some((segment) => segment.kind === "prose" && segment.text.includes(quote.text))) {
			return `The quote "${quote.text}" is inside a <thought> in Message ${quote.messageId}; a thought is never said aloud.`;
		}
	}
	const quoted = new Set(draft.quotes.map(({ text }) => text.trim()));
	const stray = draft.prompt.exampleDialogue.split("\n").map((line) => line.trim()).find((line) => line !== "" && !quoted.has(line));
	return stray === undefined ? undefined : `The exampleDialogue line "${stray}" is not one of the quotes; every line must be a quote's text.`;
};

const MEMORY = "Memory at the start of the draft. `people` lists labels on the story's path. `claims[label]` lists that person's Claims and their source Messages.";

/** @approved Groups the full Claims using only the people field the Drafter needs to interpret. */
const groupClaims = (claims: Static<typeof draftClaimPeople>) => {
	const byLabel = new Map<string, typeof claims>();
	for (const claim of claims) for (const label of claim.people) {
		const group = byLabel.get(label);
		if (group === undefined) byLabel.set(label, [claim]);
		else group.push(claim);
	}
	return { people: [...byLabel.keys()], claims: Object.fromEntries(byLabel) };
};

// @approved
//  What Memory knows, asked once when the run starts so it answers for the
// same story as `messages`: its people, and the Claims about each. The schema
// comes from the Exports Memory declares, so the agent sees their shape.
// Without Memory there is nothing to ask, and a Memory that fails to answer
// leaves the draft to the raw history, saying why.
const memoryGlobal = (exports: BoxExports): CodeAgentGlobal => {
	const selectedClaims = exports.memory?.selectedClaims;
	if (selectedClaims === undefined) return { description: "Null: Memory is not enabled in this Chat.", schema: draftMemory(), value: null };
	try {
		const output = selectedClaims.output;
		const claims = selectedClaims();
		if (!TypeGuard.IsArray(output) || !Value.Check(draftClaimPeople, claims)) throw new Error("its selected Claims do not list their people.");
		const schema = draftMemory(output);
		return { description: MEMORY, schema, value: groupClaims(claims) };
	} catch (error) {
		return { description: `Null: Memory could not answer: ${error instanceof Error ? error.message : String(error)}`, schema: draftMemory(), value: null };
	}
};

/** @approved Memory's person labels, empty when Memory is not enabled in the Chat or its answer fails. */
const memoryPeople = (exports: BoxExports): readonly string[] => {
	try {
		const people = exports.memory?.people?.();
		return Value.Check(draftPeople, people) ? people : [];
	} catch { return []; }
};

/** @approved Model availability and Memory's labels for an existing Chat. */
export const readDrafter = (database: Database, conversationId: number, exportsOf: (conversationId: number) => BoxExports): DrafterRead | undefined => {
	if (!conversationExists(database, conversationId)) return undefined;
	return { people: [...memoryPeople(exportsOf(conversationId))], unavailable: codeAgentUnavailable(database) ?? null };
};

const MESSAGES = "The story's Selected narrative path, in order: each Message's id, its index on the path, its author's name and Participant id as written, and its text.";
const CAST = "The Chat's Cast: each Participant's id and the names it has been written under, its current name first.";

const instructions = ({ person, instruction, participantId }: DraftRequest, cast: DraftCast) => {
	const member = cast.find(({ id }) => id === participantId);
	const steer = instruction?.trim() ?? "";
	return [
		[
			`You write a Definition for one person in a story, as the story so far shows them. The person: ${person}.`,
			...member === undefined ? [] : [`They are the Cast member with id ${member.id}, whose Messages were written under ${member.names.join(", ")}.`],
			...steer === "" ? [] : [`The writer asks: ${steer}`],
		].join(" "),
		"",
		"Read the story with the run tool before you write. `messages` is the Selected narrative path in order, `cast` lists the Chat's Participants, and `memory` holds the people Memory knows and its Claims about each, when Memory is enabled. Text inside <thought>…</thought> is a character's unspoken thought: nobody else heard it.",
		"Find every place the person appears, under each of their names. When the story gives a fuller name, such as Bartholomew Crane for Bob, use the fuller name as `name`.",
		"",
		"Write the prompt:",
		"- identity: who they are. Write what the story establishes as fact plainly, as fact. Put what other people say about them in one paragraph of its own that starts \"Reputation:\" and says who says it. Write the person's own beliefs as their point of view, such as \"She believes…\", never as facts about the world.",
		"- appearance: how they look, as text, from what the story describes; empty when it describes nothing.",
		"- scenario: where they stand in the story now, in a sentence or two.",
		"- systemInstruction and postHistoryInstruction: empty.",
		"- exampleDialogue: lines the person says in the story, one per line. Every line must be exactly the text of one of your quotes.",
		"- quotes: each line of exampleDialogue with the id of the Message it comes from. A quote's text must appear word for word in that Message's text.",
		"",
		"Submit the draft with the submit tool. A refusal says what to fix.",
	].join("\n");
};

// @approved
//  One draft: the path, the Cast and what Memory knows, captured together in
// one read transaction when it starts, explored by the Box's code agent until it submits a draft whose
// quotes and example dialogue hold up against the path. Nothing is stored;
// the draft goes back to the writer, whose choice in the Definition editor
// is the only write.
export const draftPerson = async (database: Database, exports: BoxExports, request: DraftRequest, signal: AbortSignal, onActivity: (activity: CodeAgentActivity) => void): Promise<CharacterDraft> => {
	const { conversationId, participantId } = request;
	if (!conversationExists(database, conversationId)) throw new Error("The Chat is no longer available.");
	if (readBoxLifecycles(drizzle(database), conversationId)[descriptor.id]?.state !== "enabled") throw new Error("The Character Drafter is off in this Chat.");
	const { messages, cast, memory } = database.transaction(() => {
		const path = readDraftMessages(database, conversationId);
		return { messages: path, cast: readDraftCast(database, conversationId, path), memory: memoryGlobal(exports) };
	})();
	if (participantId !== undefined && !cast.some(({ id }) => id === participantId)) throw new Error("That Participant is no longer in the Cast.");
	return await runCodeAgent(database, {
		boxId: descriptor.id,
		instructions: instructions(request, cast),
		globals: {
			messages: { description: MESSAGES, schema: draftMessages, value: messages },
			cast: { description: CAST, schema: draftCast, value: cast },
			memory,
		},
		submitSchema: characterDraft,
		verify: (draft) => draftRefusal(messages, draft),
		signal,
		onActivity,
	});
};
