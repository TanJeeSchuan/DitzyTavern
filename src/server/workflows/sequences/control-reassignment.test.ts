import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createConversationModule, type ConversationModule, type ParticipantDefinition } from "../../conversation";
import { openInitializedDatabase } from "../../database/database";
import { createFakeModelClient, type ModelClientGenerationInput } from "../../model-client";
import {
	continueGeneration,
	generateSiblingVariant,
	sendThroughProvisionalTailGeneration,
} from "..";

// Sequence coverage: configuration that changes between commands. Every case
// here reassigns a Control seat and then starts a Generation, asserting on the
// generation input the transport receives. Role assignment is only observable
// there, so these tests drive the workflow entry points rather than any
// internal derivation.

const definition = (name: string): ParticipantDefinition => ({
	name,
	prompt: {
		systemInstruction: "Write well.",
		identity: "I am {{self}}.",
		scenario: "A quiet room.",
		exampleDialogue: "",
		postHistoryInstruction: "",
	},
	openings: [],
});

interface HistoryRole {
	speakerName: string | null;
	role: "human" | "model" | null;
}

// The roles as the transport sees them. Each history block carries its own
// role, so this reads what the adapter reads rather than reconstructing it.
const historyRolesOf = (input: ModelClientGenerationInput): HistoryRole[] =>
	input.promptPlan.blocks
		.filter((block) => block.kind === "history")
		.map((block) => ({ speakerName: block.speakerName, role: block.role }));

describe("Control reassignment between commands", () => {
	let database: Database;
	let conversation: ConversationModule;
	let conversationId: number;
	let kestrelId: number;

	const revision = () => {
		const snapshot = conversation.getSnapshot(conversationId);
		if (snapshot === undefined) throw new Error("Missing Conversation.");
		return snapshot.revision;
	};

	const send = async (content: string) => {
		let received: ModelClientGenerationInput | undefined;
		await sendThroughProvisionalTailGeneration(database, {
			conversationId,
			expectedRevision: revision(),
			content,
			modelClient: createFakeModelClient((input) => {
				received = input;
				return `Reply to ${content}`;
			}),
		});
		return received;
	};

	const reassignModelSeatToKestrel = () => {
		conversation.execute({
			conversationId,
			expectedRevision: revision(),
			action: { type: "assign-control", seat: "model", participantId: kestrelId },
		});
	};

	beforeEach(async () => {
		database = openInitializedDatabase({ path: ":memory:" });
		conversation = createConversationModule(database);
		const created = conversation.create({
			name: "Cast change",
			participants: [
				{ definition: definition("Writer") },
				{ definition: definition("Maren") },
				{ definition: definition("Kestrel") },
			],
			control: { human: 0, model: 1 },
		});
		conversationId = created.id;
		kestrelId = created.cast[2]?.id ?? -1;
		// One exchange authored while Maren held the model seat, so the Message
		// carries {Writer, Maren} as its captured historical Control pair.
		await send("Open the scene.");
	});

	afterEach(() => database.close());

	test("Send presents a previous model Participant's Message as model writing", async () => {
		reassignModelSeatToKestrel();

		const received = await send("Continue the scene.");

		expect(historyRolesOf(received!)).toEqual([
			{ speakerName: "Writer", role: "human" },
			{ speakerName: "Maren", role: "model" },
			{ speakerName: "Writer", role: "human" },
		]);
	});

	test("Continuation presents a previous model Participant's Message as model writing", async () => {
		reassignModelSeatToKestrel();

		let received: ModelClientGenerationInput | undefined;
		await continueGeneration(database, {
			conversationId,
			expectedRevision: revision(),
			modelClient: createFakeModelClient((input) => {
				received = input;
				return "The scene continues.";
			}),
		});

		expect(historyRolesOf(received!)).toEqual([
			{ speakerName: "Writer", role: "human" },
			{ speakerName: "Maren", role: "model" },
		]);
	});

	test("Sibling Generation presents a previous model Participant's Message as model writing", async () => {
		reassignModelSeatToKestrel();
		// A second exchange under Kestrel gives the Swipe a target whose captured
		// pair is {Writer, Kestrel} while Maren's earlier Message remains in the
		// preceding Selected narrative path.
		await send("Take over the scene.");
		const snapshot = conversation.getSnapshot(conversationId);
		const target = snapshot?.messages.at(-1);
		if (target === undefined) throw new Error("Missing target Message.");

		let received: ModelClientGenerationInput | undefined;
		await generateSiblingVariant(database, {
			conversationId,
			messageId: target.id,
			modelClient: createFakeModelClient((input) => {
				received = input;
				return "An alternative.";
			}),
		});

		expect(historyRolesOf(received!)).toEqual([
			{ speakerName: "Writer", role: "human" },
			{ speakerName: "Maren", role: "model" },
			{ speakerName: "Writer", role: "human" },
		]);
	});

	test("a displaced human Participant's Message falls to no role", async () => {
		// The fallback is deliberately asymmetric, because the evidence is. A
		// model-authored Message captures its historical Control pair, so it can
		// still be recognised as model writing after the seat moves. A
		// Human-authored Message captures none, so once the human seat moves its
		// author matches neither the current seat nor any pair of its own and it
		// carries no role. Both a null role and "human" reach the provider as
		// user writing, so this is not writer-visible; inferring "human" from a
		// neighbouring Message's pair would be the same fabrication this rule
		// exists to prevent.
		conversation.execute({
			conversationId,
			expectedRevision: revision(),
			action: { type: "assign-control", seat: "human", participantId: kestrelId },
		});

		const received = await send("A new voice speaks.");

		expect(historyRolesOf(received!)).toEqual([
			{ speakerName: "Writer", role: null },
			{ speakerName: "Maren", role: "model" },
			{ speakerName: "Kestrel", role: "human" },
		]);
	});
});
