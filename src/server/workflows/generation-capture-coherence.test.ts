import { createConversation, readConversationSnapshot } from "../conversation";
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { openInitializedDatabase } from "../database/database";
import { initializeConnectionSecretKey } from "../connection-secrets";
import { configureDecisionModels } from "../contract/decision-model-test-fixtures";
import {
	importNativePromptPreset,
	selectConversationPromptPreset,
} from "../prompt-preset";
import { importNativeLorebook, executeLorebookCommand } from "../lorebook/library";
import { attachLorebookToConversation } from "../lorebook/attachments";
import { captureGeneration } from "./generate-capture";
import {
	createGenerationPreviewAsync,
	previewRecordFor,
} from "./generation-preview";
import type { PromptPlan } from "../prompt-compiler";
import { createConnectionSettingsModule } from "../connection-settings";
import { createGenerationCoordinator } from "../application/generation-coordinator";
import { gracefullyShutdownGenerations } from "./generation-recovery";

const prompt = {
	systemInstruction: "",
	identity: "",
	scenario: "",
	exampleDialogue: "",
	postHistoryInstruction: "",
};

const setup = () => {
	const database = openInitializedDatabase({ path: ":memory:" });
	initializeConnectionSecretKey({ environment: { CONNECTION_SECRET_KEY: Buffer.from(new Uint8Array(32).fill(5)).toString("base64") } });
	configureDecisionModels(database);
	const conversation = createConversation(database, {
		name: "Capture Coherence",
		participants: [
			{ definition: { name: "Writer", prompt, openings: [] } },
			{ definition: { name: "Maren", prompt, openings: ["The lamp turns above you."] } },
		],
		control: { human: 0, model: 1 },
	});
	const preset = importNativePromptPreset(database, {
		name: "Lore Capture",
		slots: [
			{ reference: "history", enabled: true },
			{ reference: "lore", enabled: true, role: "system" },
		],
	});
	selectConversationPromptPreset(drizzle(database), conversation.id, preset.id);
	const book = importNativeLorebook(database, {
		name: "Captured World",
		description: "",
		entries: [{
			title: "Signal",
			content: "Captured before the edit.",
			keywords: ["signal"],
			semanticTriggers: ["meaning of signal"],
			matchOperator: "or",
			always: false,
			requireAny: [],
			requireAll: [],
			excludeAny: [],
			excludeAll: [],
			caseSensitive: false,
			wholeWord: true,
			keywordMode: "literal",
			regexFlags: "",
			priority: 1,
			enabled: true,
		}],
	});
	attachLorebookToConversation(database, { conversationId: conversation.id, bookId: book.id });
	return { database, conversationId: conversation.id, targetMessageId: conversation.messages.at(-1)?.id, book };
};

const loreText = (plan: PromptPlan): string =>
	plan.blocks.find((block) => block.kind === "lore")?.content ?? "";

describe("generation capture coherence", () => {
	let databases: Database[] = [];
	afterEach(() => {
		for (const database of databases) database.close();
		databases = [];
	});

	for (const kind of ["send", "continuation", "sibling"] as const) {
		test(`${kind} retains its captured Lore while semantic preparation is suspended`, async () => {
			const state = setup();
			databases.push(state.database);
			const targetMessageId = state.targetMessageId;
			if (targetMessageId === undefined) throw new Error("The setup did not create a target Message.");

			let started!: () => void;
			let release!: () => void;
			const semanticStarted = new Promise<void>((resolve) => { started = resolve; });
			const semanticRelease = new Promise<void>((resolve) => { release = resolve; });
			let requestCount = 0;
			const preparationFetch = async () => {
				requestCount += 1;
				if (requestCount === 1) {
					started();
					await semanticRelease;
				}
				return Response.json({ answers: { trigger_0: { type: "noul", noul: 0.9 } } });
			};

			const database = state.database;
			const pending = captureGeneration(
				database,
				kind === "send"
					? { kind: "send", content: "signal" }
					: kind === "continuation"
						? { kind: "continuation" }
						: { kind: "sibling", messageId: targetMessageId },
				{connection: null, conversationId: state.conversationId, preparationFetch },
			);

			await semanticStarted;
			executeLorebookCommand(state.database, {
				type: "save-entry",
				bookId: state.book.id,
				expectedRevision: state.book.revision,
				entryId: state.book.entries[0]?.id,
				entry: {
					...state.book.entries[0],
					content: "Edited while Jev was pending.",
				},
			});
			release();

			const result = await pending;
			const capturedBook = result.preparation.lore.sources?.books[0]?.book.entries[0]?.content;
			expect(capturedBook).toBe("Captured before the edit.");
			expect(capturedBook).not.toBe("Edited while Jev was pending.");
			if (kind !== "sibling") {
				expect(loreText(result.plan.promptPlan)).toContain("Captured before the edit.");
				expect(loreText(result.plan.promptPlan)).not.toContain("Edited while Jev was pending.");
			}
		});
	}

	test("shutdown cancels suspended preparation before acceptance", async () => {
		const state = setup();
		databases.push(state.database);
		const masterKey = new Uint8Array(32).fill(5);
		createConnectionSettingsModule(state.database, { masterKey }).createProfile({
			expectedRevision: createConnectionSettingsModule(state.database, { masterKey }).get().revision,
			profile: {
				displayName: "Shutdown", apiFormat: "chat-completions", requestUrl: "http://127.0.0.1:43127/v1/",
				modelsUrl: "", modelBackend: "automatic", adapter: "deepseek", outputTokenRepresentation: "automatic",
				timeoutMs: null, pinnedModels: [],
			},
			credential: "shutdown-test-secret",
		});
		const requested = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let preparationSignal: AbortSignal | null | undefined;
		const coordinator = createGenerationCoordinator(state.database, {
			masterKey,
			fetch: async (_input, init) => {
				preparationSignal = init?.signal;
				requested.resolve();
				await release.promise;
				return Response.json({ answers: { trigger_0: { type: "noul", noul: 0.9 } } });
			},
		});
		const snapshot = readConversationSnapshot(state.database, state.conversationId)!;
		const pending = coordinator.startGeneration({
			conversationId: state.conversationId, expectedRevision: snapshot.revision, target: { kind: "send", content: "signal" },
		});
		await requested.promise;
		const rejected = pending.catch((error: Error) => error);
		await gracefullyShutdownGenerations(state.database);
		expect(preparationSignal?.aborted).toBe(true);
		expect(await rejected).toBeInstanceOf(Error);
		await expect(pending).rejects.toThrow("shutting down");
		release.resolve();
		expect(readConversationSnapshot(state.database, state.conversationId)?.messages).toEqual(snapshot.messages);
	}, 3_000);

	test("a slower preview cannot replace a newer preview for the same Conversation", async () => {
		const state = setup();
		databases.push(state.database);
		let releaseFirst!: () => void;
		let firstStarted!: () => void;
		const firstReady = new Promise<void>((resolve) => { firstStarted = resolve; });
		const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
		let requests = 0;
		const preparationFetch = async () => {
			requests += 1;
			if (requests === 1) {
				firstStarted();
				await firstRelease;
			}
			return Response.json({ answers: { trigger_0: { type: "noul", noul: 0.9 } } });
		};
		const input = { database: state.database, conversationId: state.conversationId, preparationFetch };
		const older = createGenerationPreviewAsync(state.database, {connection: null, ...input, kind: "send", content: "older" });
		await firstReady;
		const newer = await createGenerationPreviewAsync(state.database, {connection: null, ...input, kind: "send", content: "newer" });
		releaseFirst();
		await older;
		expect(previewRecordFor(state.database, newer.id, state.conversationId, "send").id).toBe(newer.id);
	});
	test("independent databases retain previews for identical Conversation IDs", async () => {
		const first = setup();
		const second = setup();
		databases.push(first.database, second.database);
		expect(first.conversationId).toBe(second.conversationId);
		const left = await createGenerationPreviewAsync(first.database, {connection: null, conversationId: first.conversationId, kind: "send", content: "First application." });
		const right = await createGenerationPreviewAsync(second.database, {connection: null, conversationId: second.conversationId, kind: "send", content: "Second application." });
		expect(previewRecordFor(first.database, left.id, first.conversationId, "send").id).toBe(left.id);
		expect(previewRecordFor(second.database, right.id, second.conversationId, "send").id).toBe(right.id);
	});

});
