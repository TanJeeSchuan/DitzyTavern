import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { participantPromptTable } from "../database/schema";
import { openDatabase } from "../database/database";
import {
	createConversationModule,
	ConversationNotPlayableError,
	SiblingVariantUnavailableError,
	type ConversationSnapshot,
	type ParticipantDefinition,
} from "../conversation";
import type { PromptPlan } from "../prompt-compiler";
import { createFakeModelClient } from "../model-client";
import { generateReply, generateSiblingVariant, startServerOwnedSiblingGeneration } from ".";

// Targeted Swipe workflow: a new sibling Variant for an existing native
// Message is generated from the target Message's captured historical Control
// pair — its current Definitions and names, the current generation settings,
// and the selected history strictly preceding the target — without changing
// current Control or the Message's Author Stamp.

const prompt = (
	overrides: Partial<ParticipantDefinition["prompt"]> = {},
): ParticipantDefinition["prompt"] => ({
	systemInstruction: "Keep the reply literary.",
	identity: "I am {{self}}, speaking to {{other}}.",
	scenario: "The fog closes in on the lantern house.",
	exampleDialogue: "",
	postHistoryInstruction: "End in silence.",
	...overrides,
});

const adHoc = (
	name: string,
	openings: readonly string[] = [],
	promptOverrides: Partial<ParticipantDefinition["prompt"]> = {},
): ParticipantDefinition => ({
	name,
	prompt: prompt(promptOverrides),
	openings,
});

const fakeModelClient = (
    response: (plan: PromptPlan) => string | Promise<string>,
) =>
	createFakeModelClient(({ promptPlan }) => response(promptPlan));

describe("Historical sibling Variant generation", () => {
	let database: Database;
	let conversation: ConversationSnapshot;
	let humanId: number;
	let modelId: number;

	beforeEach(() => {
		database = openDatabase({ path: ":memory:" });
		const snapshot = createConversationModule(database).create({
			name: "Sibling Chat",
			participants: [
				{ definition: adHoc("Writer") },
				{ definition: adHoc("Maren Voss", ["The lamp turns above you."]) },
			],
			control: { human: 0, model: 1 },
		});
		conversation = snapshot;
		const human = snapshot.cast[0];
		const model = snapshot.cast[1];
		if (human === undefined || model === undefined) {
			throw new Error("Conversation setup missing Cast Participants.");
		}
		humanId = human.id;
		modelId = model.id;
	});

	afterEach(() => {
		database.close();
	});

	const module = () => createConversationModule(database);

	const generateOnce = async (contents: string[], timestamp?: string) => {
		const plans: PromptPlan[] = [];
		for (const [index, content] of contents.entries()) {
			conversation = await generateReply(database, {
				conversationId: conversation.id,
				timestamp:
					timestamp ??
					new Date(Date.UTC(2026, 7, 20, 13, index, 0)).toISOString(),
				modelClient: fakeModelClient((plan) => {
					plans.push(plan);
					return content;
				}),
			});
		}
		return plans;
	};

	const adaptiveControl = async () => {
		// Current model Control moves to a third Participant while the older
		// Messages keep their captured Writer/Maren pair.
		const withJuno = module().execute({
			conversationId: conversation.id,
			expectedRevision: conversation.revision,
			action: { type: "add-participant", definition: adHoc("Juno Ashfeld") },
		});
		conversation = withJuno;
		const junoId = withJuno.cast[2]?.id ?? 0;
		conversation = module().execute({
			conversationId: conversation.id,
			expectedRevision: conversation.revision,
			action: { type: "assign-control", seat: "model", participantId: junoId },
		});
		return junoId;
	};

	const sibling = async (
		messageId: number,
		content: string,
		options: { timestamp?: string; capture: (plan: PromptPlan) => void },
	) => {
		conversation = await generateSiblingVariant(database, {
			conversationId: conversation.id,
			messageId,
			timestamp: options.timestamp ?? "2026-08-20T14:00:00Z",
			modelClient: fakeModelClient((plan) => {
				options.capture(plan);
				return content;
			}),
		});
		return conversation;
	};

	// The defined capture helper keeps sibling call sites compact.
	const captureInto = (plans: PromptPlan[]) => (plan: PromptPlan) => {
		plans.push(plan);
	};

	test("a sibling Variant for an older Message uses its historical pair after current model Control changes, leaving Control and the Author Stamp untouched", async () => {
		const greeting = conversation.messages[0];
		if (greeting === undefined) throw new Error("Greeting missing.");
		const originalAuthor = greeting.author;

		await generateOnce(["First reply."]);
		const generated = conversation.messages.at(-1);
		if (generated === undefined) throw new Error("Generated Message missing.");

		// Current model Control moves to Juno after both Messages existed.
		const junoId = await adaptiveControl();
		expect(conversation.control.modelParticipantId).toBe(junoId);

		const plans: PromptPlan[] = [];
		const committed = await sibling(
			generated.id,
			"Alternative to the first reply.",
			{ capture: captureInto(plans) },
		);

		// The plan comes from the historical pair, never from Juno.
		const identities = plans[0]?.blocks.filter(
			(block) => block.kind === "identity",
		);
		expect(identities).toEqual([
			{
				kind: "identity",
				role: "human",
				content: "I am Writer, speaking to Maren Voss.",
			},
			{
				kind: "identity",
				role: "model",
				content: "I am Maren Voss, speaking to Writer.",
			},
		]);
		expect(JSON.stringify(plans[0])).not.toContain("Juno");

		// The sibling lands on the target Message; Control stays on Juno.
		const message = committed.messages.find(
			(candidate) => candidate.id === generated.id,
		);
		expect(message?.variants.map((variant) => variant.content)).toEqual([
			"First reply.",
			"Alternative to the first reply.",
		]);
		expect(message?.variants[1]?.selected).toBe(true);
		expect(message?.author).toEqual(originalAuthor);
		expect(message?.author).toEqual(generated.author);
		expect(message?.historicalContext).toEqual({
			humanParticipantId: humanId,
			modelParticipantId: modelId,
		});
		expect(committed.control.modelParticipantId).toBe(junoId);
		expect(committed.control.humanParticipantId).toBe(humanId);
		expect(committed.messages).toHaveLength(2);
	});

	test("a current Definition change of the historical model Participant contributes to a later sibling generation while the Message keeps its captured author name", async () => {
		const greeting = conversation.messages[0];
		if (greeting === undefined) throw new Error("Greeting missing.");

		await generateOnce(["The keeper answers."]);

		// Rename the historical model Participant and replace its Prompt.
		const renamed = module().execute({
			conversationId: conversation.id,
			expectedRevision: conversation.revision,
			action: {
				type: "rename-participant",
				participantId: modelId,
				name: "Maren Renamed",
			},
		});
		conversation = renamed;
		conversation = module().execute({
			conversationId: conversation.id,
			expectedRevision: conversation.revision,
			action: {
				type: "replace-participant-prompt",
				participantId: modelId,
				prompt: {
					systemInstruction: "Keep the reply literary.",
					identity: "I am the keeper of {{other}}'s light.",
					scenario: "The fog closes in on the lantern house.",
					exampleDialogue: "",
					postHistoryInstruction: "End in silence.",
				},
			},
		});

		const plans: PromptPlan[] = [];
		const committed = await sibling(
			greeting.id,
			"A renewed opening.",
			{ capture: captureInto(plans) },
		);

		expect(
			plans[0]?.blocks.find(
				(block) => block.kind === "identity" && block.role === "model",
			)?.content,
		).toBe("I am the keeper of Writer's light.");
		// The Message continues displaying the captured author name.
		const message = committed.messages.find(
			(candidate) => candidate.id === greeting.id,
		);
		expect(message?.author).toEqual({
			participantId: modelId,
			capturedName: "Maren Voss",
			inCast: true,
		});
		expect(message?.variants.map((variant) => variant.content)).toEqual([
			"The lamp turns above you.",
			"A renewed opening.",
		]);
	});

	test("macros resolve against the historical pair even when the pair no longer holds either seat", async () => {
		await generateOnce(["First reply."]);
		const generated = conversation.messages.at(-1);
		if (generated === undefined) throw new Error("Generated Message missing.");

		await adaptiveControl();

		const plans: PromptPlan[] = [];
		await sibling(generated.id, "Sibling under the old pair.", {
			capture: captureInto(plans),
		});

		expect(
			plans[0]?.blocks.filter((block) => block.kind === "identity"),
		).toEqual([
			{
				kind: "identity",
				role: "human",
				content: "I am Writer, speaking to Maren Voss.",
			},
			{
				kind: "identity",
				role: "model",
				content: "I am Maren Voss, speaking to Writer.",
			},
		]);
	});

	test("an opening Message generates an additional Variant after its configured openings, preserving their native order and shared authorship", async () => {
		const greeting = conversation.messages[0];
		if (greeting === undefined) throw new Error("Greeting missing.");
		const controlBefore = conversation.control;

		const plans: PromptPlan[] = [];
		const committed = await sibling(
			greeting.id,
			"Another way the lamp turns.",
			{ capture: captureInto(plans) },
		);

		// No history precedes the opening Message.
		expect(plans[0]?.blocks.filter((block) => block.kind === "history")).toEqual(
			[],
		);

		const message = committed.messages.find(
			(candidate) => candidate.id === greeting.id,
		);
		expect(message?.variants.map((variant) => variant.content)).toEqual([
			"The lamp turns above you.",
			"Another way the lamp turns.",
		]);
		expect(message?.variants[0]?.selected).toBe(false);
		expect(message?.variants[1]?.selected).toBe(true);
		expect(message?.author).toEqual(greeting.author);
		expect(message?.author).toEqual({
			participantId: modelId,
			capturedName: "Maren Voss",
			inCast: true,
		});
		expect(committed.messages).toHaveLength(1);
		expect(committed.control).toEqual(controlBefore);
	});

	test("the target Message's existing sibling Variants are excluded from its preceding prompt history", async () => {
		const greeting = conversation.messages[0];
		if (greeting === undefined) throw new Error("Greeting missing.");

		await generateOnce(["First reply."]);
		const generated = conversation.messages.at(-1);
		if (generated === undefined) throw new Error("Generated Message missing.");

		const firstPlans: PromptPlan[] = [];
		await sibling(generated.id, "First alternative.", {
			capture: captureInto(firstPlans),
		});

		const secondPlans: PromptPlan[] = [];
		await sibling(generated.id, "Second alternative.", {
			capture: captureInto(secondPlans),
		});

		const historyOf = (plan: PromptPlan | undefined) =>
			plan?.blocks
				.filter((block) => block.kind === "history")
				.map((entry) => entry.content) ?? [];

		// Neither plan contains the target's own Variants ("First reply.",
		// "First alternative."); only the greeting precedes it.
		expect(historyOf(firstPlans[0])).toEqual(["The lamp turns above you."]);
		expect(historyOf(secondPlans[0])).toEqual(["The lamp turns above you."]);
	});

	test("sibling generation uses the selected history strictly preceding the target Message", async () => {
		const greeting = conversation.messages[0];
		if (greeting === undefined) throw new Error("Greeting missing.");

		await generateOnce(["First reply.", "Second reply."]);
		const first = conversation.messages[1];
		const second = conversation.messages[2];
		if (first === undefined || second === undefined) {
			throw new Error("Generated Messages missing.");
		}

		// A later Message's plan includes the first generated Message but not
		// itself, and not the Messages that follow it.
		const laterPlans: PromptPlan[] = [];
		await sibling(second.id, "For the second message.", {
			capture: captureInto(laterPlans),
		});

		// The middle Message's plan sees only the greeting: Messages after
		// the target are not part of its preceding selected history.
		const middlePlans: PromptPlan[] = [];
		await sibling(first.id, "For the first message.", {
			capture: captureInto(middlePlans),
		});

		const historyOf = (plan: PromptPlan | undefined) =>
			plan?.blocks
				.filter((block) => block.kind === "history")
				.map((entry) => entry.content) ?? [];

		expect(historyOf(laterPlans[0])).toEqual([
			"The lamp turns above you.",
			"First reply.",
		]);
		expect(historyOf(middlePlans[0])).toEqual(["The lamp turns above you."]);

		// Selecting a different Variant of the preceding Message changes the
		// sibling plan's history.
		const selected = first.variants[0];
		if (selected === undefined) throw new Error("Variant missing.");
		conversation = module().execute({
			conversationId: conversation.id,
			expectedRevision: conversation.revision,
			action: {
				type: "create-variant",
				messageId: first.id,
				content: "Selected alternative.",
			},
		});
		const afterSelection: PromptPlan[] = [];
		await sibling(second.id, "After the selection.", {
			capture: captureInto(afterSelection),
		});
		expect(historyOf(afterSelection[0])).toEqual([
			"The lamp turns above you.",
			"Selected alternative.",
		]);
	});

	test("missing historical context denies new sibling generation with the typed reason before the transport", async () => {
		const imported = module().create({
			name: "Mixed Chat",
			participants: [
				{ definition: adHoc("Writer") },
				{ definition: adHoc("Maren Voss") },
			],
			control: { human: 0, model: 1 },
			messages: [
				{
					timestamp: "2026-08-20T10:00:00Z",
					variants: [
						{
							content: "Preserved",
							timestamp: "2026-08-20T10:00:00Z",
							selected: true,
						},
					],
				},
			],
		});
		const message = imported.messages[0];
		if (message === undefined) throw new Error("Message missing.");

		let contacted = false;
		await expect(
			generateSiblingVariant(database, {
				conversationId: imported.id,
				messageId: message.id,
				modelClient: fakeModelClient(() => {
					contacted = true;
					return "Never reached";
				}),
			}),
		).rejects.toThrow(SiblingVariantUnavailableError);
		expect(contacted).toBe(false);
	});

	test("a historical Participant without a usable Definition denies sibling generation with the typed reason", async () => {
		const greeting = conversation.messages[0];
		if (greeting === undefined) throw new Error("Greeting missing.");

		await adaptiveControl();

		// Strip the historical model Participant's Definition; its base row
		// still satisfies the structural reference from Message history.
		drizzle(database)
			.delete(participantPromptTable)
			.where(eq(participantPromptTable.participant_id, modelId))
			.run();

		let contacted = false;
		await expect(
			generateSiblingVariant(database, {
				conversationId: conversation.id,
				messageId: greeting.id,
				modelClient: fakeModelClient(() => {
					contacted = true;
					return "Never reached";
				}),
			}),
		).rejects.toThrow(SiblingVariantUnavailableError);
		expect(contacted).toBe(false);
	});

	test("an unplayable Conversation denies sibling generation with the typed playability result", async () => {
		const incomplete = module().create({
			name: "Incomplete Import",
			messages: [
				{
					timestamp: "2026-08-20T10:00:00Z",
					variants: [
						{
							content: "Preserved",
							timestamp: "2026-08-20T10:00:00Z",
							selected: true,
						},
					],
				},
			],
		});
		const message = incomplete.messages[0];
		if (message === undefined) throw new Error("Message missing.");

		let contacted = false;
		await expect(
			generateSiblingVariant(database, {
				conversationId: incomplete.id,
				messageId: message.id,
				modelClient: fakeModelClient(() => {
					contacted = true;
					return "Never reached";
				}),
			}),
		).rejects.toThrow(ConversationNotPlayableError);
		expect(contacted).toBe(false);
	});

	test("a zero-output transport failure removes its provisional sibling and restores the prior selection", async () => {
		const greeting = conversation.messages[0];
		if (greeting === undefined) throw new Error("Greeting missing.");
		const before = module().getSnapshot(conversation.id);
		if (before === undefined) throw new Error("Snapshot missing.");

		await expect(
			generateSiblingVariant(database, {
				conversationId: conversation.id,
				messageId: greeting.id,
				modelClient: fakeModelClient(() => {
					throw new Error("Transport down.");
				}),
			}),
		).rejects.toThrow("Transport down.");

		const after = module().getSnapshot(conversation.id);
		expect(after?.messages).toEqual(before.messages);
		// Acceptance and terminal removal are both authoritative lifecycle
		// transitions even though no durable Variant remains.
		expect(after?.revision).toBe(before.revision + 2);
	});

	test("a sibling transport failure preserves visible partial output as interrupted", async () => {
		const greeting = conversation.messages[0];
		if (greeting === undefined) throw new Error("Greeting missing.");

		conversation = await generateSiblingVariant(database, {
			conversationId: conversation.id,
			messageId: greeting.id,
			modelClient: createFakeModelClient(() => [
				{ type: "content", text: "Partial sibling." },
				{ type: "failed", kind: "transport", message: "Connection dropped." },
			]),
		});

		const message = conversation.messages.find((candidate) => candidate.id === greeting.id);
		expect(message?.variants.map((variant) => variant.content)).toEqual([
			"The lamp turns above you.",
			"Partial sibling.",
		]);
		expect(message?.variants[1]?.selected).toBe(true);
		expect(message?.variants[1]?.data).toEqual(expect.arrayContaining([
			{ namespace: "generation", key: "outcome", value: "interrupted" },
			{ namespace: "generation", key: "error", value: "Connection dropped." },
		]));
	});

	test("parallel siblings reserve distinct active targets at one response position", async () => {
		const greeting = conversation.messages[0];
		if (greeting === undefined) throw new Error("Greeting missing.");
		let releaseFirst!: () => void;
		let releaseSecond!: () => void;
		const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
		const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
		const held = (text: string, gate: Promise<void>) => createFakeModelClient(() => (async function* () {
			yield { type: "content" as const, text };
			await gate;
			yield { type: "finished" as const, finishReason: "stop" as const };
		})());

		const first = startServerOwnedSiblingGeneration(database, {
			conversationId: conversation.id,
			messageId: greeting.id,
			modelClient: held("First sibling", firstGate),
		});
		const firstAccepted = await first.accepted;
		const second = startServerOwnedSiblingGeneration(database, {
			conversationId: conversation.id,
			messageId: greeting.id,
			modelClient: held("Second sibling", secondGate),
		});
		const secondAccepted = await second.accepted;
		const active = createConversationModule(database).getSnapshot(conversation.id);
		expect(active?.activeGenerations.map((entry) => entry.generationId)).toEqual([
			firstAccepted.generationId,
			secondAccepted.generationId,
		]);
		expect(firstAccepted.provisionalVariantId).not.toBe(secondAccepted.provisionalVariantId);

		releaseFirst();
		releaseSecond();
		await Promise.all([first.result, second.result]);
		expect(createConversationModule(database).getSnapshot(conversation.id)?.activeGenerations).toEqual([]);
	});
});
