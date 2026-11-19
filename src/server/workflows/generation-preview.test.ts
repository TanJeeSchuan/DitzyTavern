import { afterEach, beforeEach, expect, test, setSystemTime } from "bun:test";
import type { Database } from "bun:sqlite";
import type { GenerationTarget } from "../../shared/contract/conversation-schema";
import { formatImageReference } from "../../shared/image-reference";
import { createGenerationCoordinator } from "../application/generation-coordinator";
import { processStateFor } from "../application/process-state";
import { connectionSnapshotOf, createConnectionSettingsModule } from "../connection-settings";
import { executeConversationCommand, readConversationGenerationSettings } from "../conversation";
import { configureDecisionModels } from "../contract/decision-model-test-fixtures";
import { captureModelFetch, key, withProfile } from "../contract/prompt-preset-test-fixtures";
import { uploadImage } from "../image";
import { pngFixture } from "../image/image-fixtures";
import { createFakeModelClient, ModelClientGenerationError, type ModelClient, type ModelClientConnectionSnapshot } from "../model-client";
import type { PromptPlan } from "../prompt-compiler";
import { PromptBudgetExceededError } from "../prompt-compiler";
import { openObservedDatabase, pairChat, participantSeed } from "../test-fixtures/conversation";
import { runGenerationLifecycle, startServerOwnedGeneration } from "./generate";
import {
	consumeGenerationPreview,
	createGenerationPreviewAsync,
	GENERATION_PREVIEW_SESSION_TTL_MS,
	previewRecordFor,
	type GenerationPreviewRecord,
} from "./generation-preview";

const send = { kind: "send", content: "hello" } as const;
const connectionSettings = { masterKey: key };
const unavailable = "The inspected Prompt Plan is unavailable. Refresh it after a server restart or when it has been abandoned.";
const stale = "The Prompt Plan is stale. Refresh it before sending.";
let database: Database;

beforeEach(() => { database = openObservedDatabase(); });
afterEach(() => {
	setSystemTime();
	processStateFor(database).dispose();
	database.close();
});

const preview = (conversationId: number, target: GenerationTarget = send, connection: ModelClientConnectionSnapshot | null = null) =>
	createGenerationPreviewAsync(database, { connection, connectionSettings, conversationId, target });

const start = (
	record: GenerationPreviewRecord,
	{
		target = record.capture.preparation.target,
		connection = record.capture.preparation.connection,
		editedPlan = record.capture.plan.promptPlan,
		modelClient = createFakeModelClient(() => "Done."),
	}: { target?: GenerationTarget; connection?: ModelClientConnectionSnapshot | null; editedPlan?: PromptPlan; modelClient?: ModelClient } = {},
) => runGenerationLifecycle(database, {
	conversationId: record.capture.preparation.conversationId,
	connection,
	connectionSettings,
	target,
	modelClient,
	preview: { record, editedPlan },
});

const editSystemInstruction = (record: GenerationPreviewRecord, content: string): PromptPlan => {
	const plan = record.capture.plan.promptPlan;
	return { ...plan, blocks: plan.blocks.map((block) => block.kind === "system-instruction" ? { ...block, content } : block) };
};

const openingChat = () => {
	const chat = pairChat(database, "Opening Preview Chat", {
		participants: [participantSeed("Writer"), participantSeed("Maren", { openings: ["Opening."] })],
	});
	const message = chat.messages[0];
	if (message === undefined) throw new Error("Opening Message missing.");
	return { chat, sibling: { kind: "sibling", messageId: message.id } as const };
};

test("consuming an accepted preview leaves a replacement preview available", async () => {
	const chat = pairChat(database, "Preview replacement");
	const accepted = await preview(chat.id);
	const replacement = await preview(chat.id);
	expect(() => consumeGenerationPreview(database, accepted)).not.toThrow();
	expect(previewRecordFor(database, replacement.id, chat.id).id).toBe(replacement.id);
	consumeGenerationPreview(database, replacement);
	expect(() => consumeGenerationPreview(database, replacement)).not.toThrow();
});

test("sends the edited plan literally and preserves expansion-time writes", async () => {
	const originalRandom = Math.random;
	Math.random = () => 0.3;
	try {
		const chat = pairChat(database, "Preview Chat");
		database.query("UPDATE participant_prompt SET system_instruction = ? WHERE participant_id = ?")
			.run("Rolled 7 {{setvar::rollResult::{{roll::1d20}}}}", chat.cast[1]!.id);
		const record = await preview(chat.id);
		const writes = () => database.query<{ value: string }, []>("SELECT value FROM message_variant_data WHERE namespace = 'prompt-macro'").all();
		expect(writes()).toEqual([]);
		const content = "Rolled 18 {{roll::1d20}}";
		const request = Promise.withResolvers<PromptPlan>();
		const modelClient = createFakeModelClient(({ promptPlan }) => {
			request.resolve(promptPlan);
			return "Done.";
		});

		await start(record, { editedPlan: editSystemInstruction(record, content), modelClient });

		expect((await request.promise).blocks).toContainEqual(expect.objectContaining({ kind: "system-instruction", role: "system", content }));
		expect(writes().some(({ value }) => JSON.parse(value).some((write: { value?: unknown }) => write.value === "7"))).toBe(true);
	} finally {
		Math.random = originalRandom;
	}
});

test("retries a failed edited Send with its plan and a fresh preview token", async () => {
	const chat = pairChat(database, "Preview Chat");
	database.query("UPDATE participant_prompt SET system_instruction = ? WHERE participant_id = ?")
		.run("Answer briefly.", chat.cast[1]!.id);
	const target = { kind: "send", content: "The next scene begins." } as const;
	const first = await preview(chat.id, target);
	const editedPlan = editSystemInstruction(first, "Writer-edited instruction.");
	const requests: PromptPlan[] = [];
	const modelClient = createFakeModelClient(({ promptPlan }) => {
		requests.push(promptPlan);
		if (requests.length === 1) throw new ModelClientGenerationError("provider", "unsupported image input");
		return "Recovered.";
	});
	await expect(start(first, { editedPlan, modelClient })).rejects.toThrow("unsupported image input");

	const retry = await preview(chat.id, target);
	expect(retry.id).not.toBe(first.id);
	expect(retry.capture.plan.promptPlan.blocks).toHaveLength(first.capture.plan.promptPlan.blocks.length);
	await start(retry, { editedPlan, modelClient });

	expect(requests).toHaveLength(2);
	expect(requests[1]?.blocks).toContainEqual(expect.objectContaining({ kind: "system-instruction", role: "system", content: "Writer-edited instruction." }));
});

test("keeps a preview valid after an unrelated cast addition", async () => {
	const chat = pairChat(database, "Preview Chat");
	const record = await preview(chat.id);
	executeConversationCommand(database, {
		conversationId: chat.id,
		expectedRevision: chat.revision,
		action: { type: "add-participant", definition: participantSeed("Extra").definition },
	});
	expect((await start(record)).conversation.id).toBe(chat.id);
});

test("does not apply a plan edit that exceeds the captured context ceiling", async () => {
	const chat = pairChat(database, "Preview Chat");
	const record = await preview(chat.id);
	const plan = record.capture.plan.promptPlan;
	const editedPlan = { ...plan, blocks: plan.blocks.map((block) => ({ ...block, content: "x".repeat(500_000) })) };
	await expect(start(record, { editedPlan })).rejects.toThrow(PromptBudgetExceededError);
});

test.each(["plain", "missing", "stored"])("accepts an Image added to a %s text-only preview without charging image tokens", async (initial) => {
	const chat = pairChat(database, "Preview Chat");
	const connections = createConnectionSettingsModule(database, connectionSettings);
	const profile = withProfile(database).profiles[0];
	if (profile === undefined) throw new Error("Connection Profile missing.");
	connections.setTextOnlyModel({ profileId: profile.id, modelId: "text-only", textOnly: true });
	const settings = readConversationGenerationSettings(database, chat.id);
	if (settings === undefined) throw new Error("Generation settings missing.");
	executeConversationCommand(database, {
		conversationId: chat.id,
		expectedRevision: chat.revision,
		action: { type: "update-generation-settings", settings: { ...settings, modelId: "text-only", contextLimit: 2_000, responseBudget: 100, safetyAllowance: 0 } },
	});
	const image = await uploadImage(database, pngFixture({ width: 1568, height: 1568 }));
	const reference = formatImageReference("map", image.hash);
	const content = initial === "plain" ? "Look" : `Look ${initial === "missing" ? formatImageReference("ghost", "f".repeat(64)) : reference}`;
	const target = { kind: "send", content } as const;
	const provider = captureModelFetch();
	const { connection, modelClient } = createGenerationCoordinator(database, { ...connectionSettings, fetch: provider.fetch }).resolveTransport(database, profile.id);
	const record = await preview(chat.id, target, connection);
	const plan = record.capture.plan.promptPlan;
	const editedPlan = {
		...plan,
		blocks: plan.blocks.map((block) => block.kind === "history" ? { ...block, content: `${block.content} ${reference}` } : block),
	};

	await start(record, { editedPlan, modelClient });

	const request = await provider.captured;
	expect(request.messages.find((message) => message.role === "user")?.content)
		.toBe(`${initial === "plain" ? "Look" : `Look [Image: ${initial === "missing" ? "ghost" : "map"}]`} [Image: map]`);
});

test("expires an inspected plan after the preview session lifetime", async () => {
	const chat = pairChat(database, "Preview Chat");
	const record = await preview(chat.id);
	setSystemTime(record.createdAt + GENERATION_PREVIEW_SESSION_TTL_MS);
	expect(() => previewRecordFor(database, record.id, chat.id)).toThrow(unavailable);
});

test("requires a refresh after the process-local preview registry is cleared", async () => {
	const chat = pairChat(database, "Preview Chat");
	const record = await preview(chat.id);
	processStateFor(database).dispose();
	expect(() => previewRecordFor(database, record.id, chat.id)).toThrow(unavailable);
});

test("consumes a Send preview token after acceptance", async () => {
	const chat = pairChat(database, "Preview Chat");
	const record = await preview(chat.id);
	await start(record);
	expect(() => previewRecordFor(database, record.id, chat.id)).toThrow(unavailable);
});

test("keeps a preview token retryable after edited-plan validation fails", async () => {
	const chat = pairChat(database, "Preview Chat");
	const record = await preview(chat.id);
	const invalidPlan = { ...record.capture.plan.promptPlan, blocks: [] };
	await expect(start(record, { editedPlan: invalidPlan })).rejects.toThrow("The edited Prompt Plan must keep its assembled blocks.");
	expect((await start(record)).conversation.id).toBe(chat.id);
});

test("consumes a Sibling preview token after acceptance", async () => {
	const { chat, sibling } = openingChat();
	const record = await preview(chat.id, sibling);
	await start(record);
	expect(() => previewRecordFor(database, record.id, chat.id)).toThrow(unavailable);
});

test("keeps a Sibling preview token retryable after acceptance fails", async () => {
	const { chat, sibling } = openingChat();
	const settings = readConversationGenerationSettings(database, chat.id);
	if (settings === undefined) throw new Error("Generation settings missing.");
	executeConversationCommand(database, {
		conversationId: chat.id,
		expectedRevision: chat.revision,
		action: { type: "update-generation-settings", settings: { ...settings, siblingGenerationLimit: 1 } },
	});
	const gate = Promise.withResolvers<string>();
	const occupied = startServerOwnedGeneration(database, {
		conversationId: chat.id,
		connection: null,
		target: sibling,
		modelClient: createFakeModelClient(() => gate.promise),
	});
	let record: GenerationPreviewRecord;
	try {
		await occupied.accepted;
		record = await preview(chat.id, sibling);
		await expect(start(record)).rejects.toThrow("The Conversation already has 1 active Sibling Generations at this response position.");
	} finally {
		gate.resolve("");
		await expect(occupied.result).rejects.toThrow("Generation produced no usable output.");
	}
	expect((await start(record)).conversation.id).toBe(chat.id);
});

test("rejects a Send submitted with a Continuation preview token", async () => {
	const { chat } = openingChat();
	const record = await preview(chat.id, { kind: "continuation" });
	await expect(start(record, { target: send })).rejects.toThrow("The submitted Generation target changed. Refresh the Prompt Plan before sending.");
});

test("keeps only the newest inspected plan for a Conversation", async () => {
	const chat = pairChat(database, "Preview Chat");
	const first = await preview(chat.id, { kind: "send", content: "first" });
	const second = await preview(chat.id, { kind: "send", content: "second" });
	expect(() => previewRecordFor(database, first.id, chat.id)).toThrow(unavailable);
	expect((await start(second)).conversation.id).toBe(chat.id);
});

test("requires a refresh when the inactive Continuation instruction changes", async () => {
	const chat = pairChat(database, "Preview Chat");
	const record = await preview(chat.id);
	const settings = readConversationGenerationSettings(database, chat.id);
	if (settings === undefined) throw new Error("Generation settings missing.");
	executeConversationCommand(database, {
		conversationId: chat.id,
		expectedRevision: chat.revision,
		action: { type: "update-generation-settings", settings: { ...settings, continuationInstruction: "A different instruction." } },
	});
	await expect(start(record)).rejects.toThrow(stale);
});

test("requires a refresh when an unused Definition field changes", async () => {
	const chat = pairChat(database, "Preview Chat");
	const record = await preview(chat.id);
	const human = chat.cast[0];
	if (human === undefined) throw new Error("Human Participant missing.");
	executeConversationCommand(database, {
		conversationId: chat.id,
		expectedRevision: chat.revision,
		action: { type: "replace-participant-prompt", participantId: human.id, prompt: { ...human.prompt, scenario: "Unused scenario." } },
	});
	await expect(start(record)).rejects.toThrow(stale);
});

test("requires a refresh when selected history changes", async () => {
	const chat = pairChat(database, "Preview Chat");
	const record = await preview(chat.id);
	executeConversationCommand(database, {
		conversationId: chat.id,
		expectedRevision: chat.revision,
		action: { type: "create-message", timestamp: "2026-09-13T00:00:00.000Z", variantContents: ["A changed direction."], authorParticipantId: chat.cast[0]!.id },
	});
	await expect(start(record)).rejects.toThrow(stale);
});

test("requires a refresh after replacing or clearing the Decision Model credential", async () => {
	const chat = pairChat(database, "Preview Chat");
	const writingProfile = withProfile(database).profiles[0];
	if (writingProfile === undefined) throw new Error("Connection Profile missing.");
	const { decisionProfileId } = configureDecisionModels(database, key, undefined, { credential: "original-secret" });
	const connections = createConnectionSettingsModule(database, connectionSettings);
	const connection = () => connectionSnapshotOf(connections.get(), writingProfile);

	const first = await preview(chat.id, send, connection());
	connections.setCredential({ expectedRevision: connections.get().revision, profileId: decisionProfileId, credential: "replacement-secret" });
	await expect(start(first, { connection: connection() })).rejects.toThrow(stale);

	const second = await preview(chat.id, send, connection());
	connections.resetCredential({ expectedRevision: connections.get().revision, profileId: decisionProfileId, confirmed: true });
	await expect(start(second, { connection: connection() })).rejects.toThrow(stale);
});
