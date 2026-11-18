import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Value } from "@sinclair/typebox/value";
import { codeAgentUnavailable, conversationExists, readBoxLifecycles, readChatVariants, readParticipants, runCodeAgent, type BoxExports, type CodeAgentActivity } from "@/box-sdk/server";
import descriptor from "./shared-descriptor";
import { characterDraft, draftCast, draftExports, draftMessages, draftPeople, type CharacterDraft, type DraftCast, type DraftMessages, type DraftRequest, type DrafterRead } from "./contract";

/** @approved The Selected narrative path as the agent reads it, a settled Variant per Message. */
export const readDraftMessages = (database: Database, conversationId: number): DraftMessages =>
	readChatVariants(database, conversationId).filter(({ selected }) => selected)
		.map(({ messageId, speaker, authorParticipantId, content }, index) => ({ id: messageId, index, author: speaker, authorParticipantId, text: content }));

const readDraftCast = (database: Database, conversationId: number, messages: DraftMessages): DraftCast =>
	readParticipants(database, conversationId).filter(({ removed }) => !removed).map(({ id, name }) => ({
		id, names: [...new Set([name, ...messages.flatMap(({ author, authorParticipantId }) => authorParticipantId === id && author !== null ? [author] : [])])],
	}));

// @approved
//  Why the draft is refused, or undefined: every quote is copied word for
// word from a Message on the path, and every line of `exampleDialogue` is one
// of the quotes, so the person's voice is never invented.
export const draftRefusal = (messages: DraftMessages, draft: CharacterDraft): string | undefined => {
	const texts = new Map(messages.map(({ id, text }) => [id, text]));
	for (const quote of draft.quotes) {
		const text = texts.get(quote.messageId);
		if (text === undefined) return `Message ${quote.messageId} is not on the story's path.`;
		if (!text.includes(quote.text)) return `The quote "${quote.text}" is not in Message ${quote.messageId} word for word.`;
	}
	const quoted = new Set(draft.quotes.map(({ text }) => text.trim()));
	const stray = draft.prompt.exampleDialogue.split("\n").map((line) => line.trim()).find((line) => line !== "" && !quoted.has(line));
	return stray === undefined ? undefined : `The exampleDialogue line "${stray}" is not one of the quotes; every line must be a quote's text.`;
};

/** @approved What other enabled Boxes answer about this Chat, without the drafter's own entry, each Export with the signature its Box declares. */
const exportsGlobal = (exports: BoxExports) => {
	const others = Object.fromEntries(Object.entries(exports).filter(([id]) => id !== descriptor.id));
	const described = Object.entries(others).flatMap(([id, box]) => Object.entries(box).map(([name, ask]) => `exports.${id}.${name}: ${ask.description}`));
	return {
		description: described.length === 0 ? "What other Boxes answer about this Chat; none enabled here answers anything." : `What other Boxes answer about this Chat. ${described.join(" ")}`,
		schema: draftExports(others),
		value: others,
	};
};

/** @approved Memory's person labels, empty when Memory is not enabled in the Chat or its answer fails. */
const memoryPeople = (exports: BoxExports): readonly string[] => {
	try {
		const people = exports.memory?.people?.();
		return Value.Check(draftPeople, people) ? people : [];
	} catch { return []; }
};

/** @approved The window's read: the people Memory knows, and why a draft cannot start. */
export const readDrafter = (database: Database, exports: BoxExports): DrafterRead =>
	({ people: [...memoryPeople(exports)], unavailable: codeAgentUnavailable(database, descriptor.id) ?? null });

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
		"Read the story with the run tool before you write. `messages` is the Selected narrative path in order, `cast` lists the Chat's Participants, and `exports` holds what other Boxes answer about this Chat, such as the Claims Memory holds about a person. Text inside <thought>…</thought> is a character's unspoken thought: nobody else heard it.",
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
//  One draft: the path, the Cast and the other Boxes' Exports captured when
// it starts, explored by the Box's code agent until it submits a draft whose
// quotes and example dialogue hold up against the path. Nothing is stored;
// the draft goes back to the writer, whose choice in the Definition editor
// is the only write.
export const draftPerson = async (database: Database, exports: BoxExports, request: DraftRequest, signal: AbortSignal, onActivity: (activity: CodeAgentActivity) => void): Promise<CharacterDraft> => {
	const { conversationId, participantId } = request;
	if (!conversationExists(database, conversationId)) throw new Error("The Chat is no longer available.");
	if (readBoxLifecycles(drizzle(database), conversationId)[descriptor.id]?.state !== "enabled") throw new Error("The Character Drafter is off in this Chat.");
	const messages = readDraftMessages(database, conversationId);
	const cast = readDraftCast(database, conversationId, messages);
	if (participantId !== undefined && !cast.some(({ id }) => id === participantId)) throw new Error("That Participant is no longer in the Cast.");
	return await runCodeAgent(database, {
		boxId: descriptor.id,
		instructions: instructions(request, cast),
		globals: {
			messages: { description: MESSAGES, schema: draftMessages, value: messages },
			cast: { description: CAST, schema: draftCast, value: cast },
			exports: exportsGlobal(exports),
		},
		submitSchema: characterDraft,
		verify: (draft) => draftRefusal(messages, draft),
		signal,
		onActivity,
	});
};
