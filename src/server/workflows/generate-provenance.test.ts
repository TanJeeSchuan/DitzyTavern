import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { createConversationModule } from "../conversation";
import type { ParticipantDefinition } from "../conversation";
import { requireSnapshot } from "../conversation/test-fixtures";
import type { PromptPlan } from "../prompt-compiler";
import {
	createFakeModelClient,
	projectModelClientGenerationSettings,
	type ModelClientGenerationInput,
} from "../model-client";
import { createConnectionSettingsModule } from "../connection-settings";
import {
	generateSiblingVariant,
	sendThroughProvisionalTailGeneration,
} from ".";
import { generateTerminalTailFixture } from "./test-fixtures";
import { createGenerationPreviewAsync } from "./generation-preview";

import { observeConversationWrites } from "../conversation";
import { syncMemorySources } from "../memory";
const prompt = (
	overrides: Partial<ParticipantDefinition["prompt"]> = {},
): ParticipantDefinition["prompt"] => ({
	systemInstruction: "Keep the reply literary.",
	identity: "I am {{self}}, speaking to {{other}}.",
	scenario: "The fog closes in on the lantern house.",
	exampleDialogue: "<START>\n{{user}}: Who tends the light?",
	postHistoryInstruction: "End with a question.",
	...overrides,
});

const adHoc = (
	name: string,
	openings: string[] = [],
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

describe("Generation capture and provenance", () => {
	let database: Database;
	let conversationId: number;

	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
		observeConversationWrites(database, syncMemorySources);
		const snapshot = createConversationModule(database).create({
			name: "Generating Chat",
			participants: [
				{ definition: adHoc("Writer") },
				{ definition: adHoc("Maren Voss", ["The lamp turns above you."]) },
			],
			control: { human: 0, model: 1 },
		});
		conversationId = snapshot.id;
	});

	afterEach(() => {
		database.close();
	});

	test("captures effective settings and safe Profile provenance before a streamed request", async () => {
		const key = new Uint8Array(32).fill(19);
		const settingsModule = createConnectionSettingsModule(database, { masterKey: key });
		const profile = {
			displayName: "DeepSeek",
			apiFormat: "chat-completions" as const,
			requestUrl: "https://api.deepseek.com/",
			modelsUrl: "https://api.deepseek.com/models",
			modelBackend: "automatic" as const,
			adapter: "deepseek" as const,
			outputTokenRepresentation: "automatic" as const,
			timeoutMs: 120_000,
			pinnedModels: ["custom-before-discovery"],
		};
		const created = settingsModule.createProfile({
			expectedRevision: 0,
			profile,
			credential: "credential-never-stored-in-provenance",
		});
		const conversation = createConversationModule(database);
		const configuredConversation = conversation.execute({
			conversationId,
			expectedRevision: 0,
			action: {
				type: "update-generation-settings",
				settings: {
					modelId: "custom-before-discovery",
					temperature: 0.4,
					topP: null,
					frequencyPenalty: null,
					presencePenalty: null,
					contextLimit: 8192,
					responseBudget: 128,
					safetyAllowance: 500,
					siblingGenerationLimit: 4,
					continuationStrategy: "instruction",
					continuationInstruction: "Continue the narrative naturally without repeating the previous text.",
					continuationPrefillSuffix: "",
					repeatedImagePlacement: "last",
					requestOverrides: {
						"chat-completions": { response_format: { type: "text" } },
						responses: {},
						"anthropic-messages": {},
					},
					},
			},
		});
		const profileId = created.profiles[0]!.id;
		const updatedConversation = conversation.execute({
			conversationId,
			expectedRevision: configuredConversation.revision,
			action: { type: "set-generation-model", connectionProfileId: profileId, modelId: "custom-before-discovery" },
		});
		expect(conversation.getGenerationSettings(conversationId)?.modelId).toBe(
			"custom-before-discovery",
		);

		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		let receivedInput: { modelId?: string; generationSettings?: unknown } | undefined;
		const generation = generateTerminalTailFixture(database, {
			conversationId,
			connectionSettings: { masterKey: key },
			modelClient: {
				async *generate(input) {
					receivedInput = input;
					await pending;
					yield { type: "content", text: "Streamed response." };
					yield { type: "finished", finishReason: "stop" };
				},
			},
		});

		// A Profile edit during transport is authoritative for the next
		// Generation, never for the already captured one.
		settingsModule.applyProfile({
			expectedRevision: created.revision,
			profileId,
			profile: { ...profile, displayName: "Edited after start" },
		});
		release();
		await generation;
		expect(receivedInput?.modelId).toBe("custom-before-discovery");
		expect(receivedInput?.generationSettings).toMatchObject({
		responseBudget: 128,
		contextLimit: 8192,
	});
		const variant = requireSnapshot(createConversationModule(database), conversationId).messages.at(-1)?.variants.at(-1);
		const provenance = variant?.data.find(
			(entry) => entry.namespace === "generation" && entry.key === "provenance",
		);
		if (provenance === undefined) throw new Error("Generation provenance missing.");
		// SAFETY: the provenance value was written by the workflow immediately
		// above and this test reads only its safe identity and settings fields.
		const parsed = JSON.parse(provenance.value) as {
			connectionProfileId: number;
			connectionSettingsRevision: number;
			modelBackend: string;
			adapter: string;
			modelId: string;
			generationSettings: { responseBudget: number };
		};
		expect(parsed).toMatchObject({
			connectionProfileId: profileId,
			connectionSettingsRevision: created.revision,
			modelBackend: "ai-sdk",
			adapter: "deepseek",
			modelId: "custom-before-discovery",
			generationSettings: { responseBudget: 128 },
		});
		expect(provenance.value).not.toContain("credential-never-stored-in-provenance");
		expect(provenance.value).not.toContain("api.deepseek.com");
		expect(updatedConversation.revision).toBe(2);
	});

	test("supplies only the active API Format's Request Overrides and matches the inspected effective settings", async () => {
		const key = new Uint8Array(32).fill(23);
		const settingsModule = createConnectionSettingsModule(database, { masterKey: key });
		const created = settingsModule.createProfile({
			expectedRevision: 0,
			profile: {
				displayName: "Chat Completions",
				apiFormat: "chat-completions" as const,
				requestUrl: "https://api.example.invalid/v1/",
				modelsUrl: "https://api.example.invalid/models",
				modelBackend: "automatic" as const,
				adapter: "deepseek" as const,
				outputTokenRepresentation: "automatic" as const,
				timeoutMs: null,
				pinnedModels: [],
			},
		});
		const conversation = createConversationModule(database);
		const configuredConversation = conversation.execute({
			conversationId,
			expectedRevision: 0,
			action: {
				type: "update-generation-settings",
				settings: {
					modelId: "override-model",
					temperature: 0.25,
					topP: null,
					frequencyPenalty: null,
					presencePenalty: null,
					contextLimit: 8192,
					responseBudget: 128,
					safetyAllowance: 500,
					siblingGenerationLimit: 4,
					continuationStrategy: "instruction",
					continuationInstruction: "Continue the narrative naturally without repeating the previous text.",
					continuationPrefillSuffix: "",
					repeatedImagePlacement: "last",
					requestOverrides: {
						"chat-completions": { logit_bias: { "50256": -100 } },
						responses: { metadata: { workspace: "responses-only" } },
						"anthropic-messages": { metadata: { workspace: "anthropic-only" } },
					},
				},
			},
		});
		conversation.execute({
			conversationId,
			expectedRevision: configuredConversation.revision,
			action: {
				type: "set-generation-model",
				connectionProfileId: created.profiles[0]!.id,
				modelId: "override-model",
			},
		});

		const preview = await createGenerationPreviewAsync(database, {
			conversationId,
			kind: "send",
			content: "Send with narrowed overrides.",
			connectionSettings: { masterKey: key },
		});
		if (preview.capture.kind !== "send") throw new Error("Expected a Send preview.");
		const effectiveSettings = preview.capture.plan.effectiveSettings;

		let receivedSettings: ModelClientGenerationInput["generationSettings"] | undefined;
		await sendThroughProvisionalTailGeneration(database, {
			conversationId,
			expectedRevision: 2,
			content: "Send with narrowed overrides.",
			connectionSettings: { masterKey: key },
			modelClient: createFakeModelClient((input) => {
				receivedSettings = input.generationSettings;
				return "Narrowed overrides output.";
			}),
		});

		// Only the active API Format namespace reaches the Model Client input;
		// the inactive namespaces stay editable and are never transmitted.
		if (receivedSettings === undefined) throw new Error("Expected the Model Client input.");
		expect(receivedSettings.requestOverrides).toEqual({ logit_bias: { "50256": -100 } });
		// Preview and execution produce equivalent settings from the same
		// captured inputs.
		expect(projectModelClientGenerationSettings(effectiveSettings))
			.toEqual(receivedSettings);

		const message = requireSnapshot(createConversationModule(database), conversationId).messages.at(-1);
		const variant = message?.variants[0];
		if (message === undefined || variant === undefined) throw new Error("Variant missing.");
		const provenance = variant.data.find(
			(entry) => entry.namespace === "generation" && entry.key === "provenance",
		);
		if (provenance === undefined) throw new Error("Generation provenance missing.");
		// SAFETY: the provenance value was written by the workflow immediately
		// above and this test reads only its retained settings projection.
		const parsed = JSON.parse(provenance.value) as {
			generationSettings: { continuationStrategy: string | null };
		};
		// A Tail attempt records no applicable Continuation strategy operand.
		expect(parsed.generationSettings.continuationStrategy).toBeNull();
		// Provenance is a positive allow-list: no Request Overrides namespace is
		// retained at all.
		expect(provenance.value).not.toContain("responses-only");
		expect(provenance.value).not.toContain("anthropic-only");
		expect(provenance.value).not.toContain("logit_bias");
	});

	test("stores independent safe settings provenance for sibling Variants", async () => {
		const conversation = createConversationModule(database);
		conversation.execute({
			conversationId,
			expectedRevision: 0,
			action: {
				type: "update-generation-settings",
				settings: {
					modelId: "first-model",
					temperature: null,
					topP: null,
					frequencyPenalty: null,
					presencePenalty: null,
					contextLimit: 4096,
					responseBudget: 64,
					safetyAllowance: 500,
					siblingGenerationLimit: 4,
					continuationStrategy: "instruction",
					continuationInstruction: "Continue the narrative naturally without repeating the previous text.",
					continuationPrefillSuffix: "",
					repeatedImagePlacement: "last",
					requestOverrides: {
						"chat-completions": {},
						responses: {},
						"anthropic-messages": {},
					},
				},
			},
		});
		const first = await generateTerminalTailFixture(database, {
			conversationId,
			modelClient: fakeModelClient(() => "first generation"),
		});
		const targetId = first.messages.at(-1)?.id;
		if (targetId === undefined) throw new Error("Expected a generated Message.");
		const secondSettings = conversation.execute({
			conversationId,
			expectedRevision: first.revision,
			action: {
				type: "update-generation-settings",
				settings: {
					modelId: "second-model",
					temperature: null,
					topP: null,
					frequencyPenalty: null,
					presencePenalty: null,
					contextLimit: 2048,
					responseBudget: 128,
					safetyAllowance: 500,
					siblingGenerationLimit: 4,
					continuationStrategy: "instruction",
					continuationInstruction: "Continue the narrative naturally without repeating the previous text.",
					continuationPrefillSuffix: "",
					repeatedImagePlacement: "last",
					requestOverrides: {
						"chat-completions": {},
						responses: {},
						"anthropic-messages": {},
					},
				},
			},
		});
		await generateSiblingVariant(database, {
			conversationId,
			messageId: targetId,
			modelClient: fakeModelClient(() => "sibling generation"),
		});
		const target = requireSnapshot(createConversationModule(database), conversationId).messages.find((message) => message.id === targetId);
		if (target === undefined) throw new Error("Target Message disappeared.");
		const provenance = target.variants.map((variant) => {
			const entry = variant.data.find((item) => item.key === "provenance");
			if (entry === undefined) throw new Error("Sibling provenance missing.");
			// SAFETY: both entries were written by the generation workflow and this
			// test reads only the captured model id.
			return (JSON.parse(entry.value) as { modelId: string }).modelId;
		});
		expect(provenance).toEqual([
			"first-model",
			"second-model",
		]);
		// One settings command plus two lifecycle transitions per fixture.
		expect(secondSettings.revision).toBe(4);
	});


});
