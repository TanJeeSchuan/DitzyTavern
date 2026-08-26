import { describe, expect, test } from "bun:test";
import type { ConnectionSettingsEditorState } from "./connection-settings-state";
import { copyDraft, preserveConnectionDraftOnConflict } from "./connection-settings-state";

const draft = {
	displayName: "Local draft",
	apiFormat: "chat-completions" as const,
	requestUrl: "http://127.0.0.1:8080/v1/",
	modelsUrl: "",
	modelBackend: "automatic" as const,
	adapter: "openai-compatible" as const,
	outputTokenRepresentation: "automatic" as const,
	timeoutMs: 30_000,
	pinnedModels: ["local-model"],
	backendOptions: { temperature: 0.2 },
};

const state: ConnectionSettingsEditorState = {
	settings: { revision: 3, activeProfileId: 1, profiles: [] },
	selectedProfileId: 1,
	draft,
	credentialDraft: "replacement-secret",
	conflict: null,
};

describe("preserveConnectionDraftOnConflict", () => {
	test("refreshes authoritative settings without discarding the complete local draft", () => {
		const conflict = {
			outcome: "conflict" as const,
			expectedRevision: 3,
			actualRevision: 4,
			currentSettings: {
				revision: 4,
				activeProfileId: 2,
				profiles: [],
			},
		};

		const next = preserveConnectionDraftOnConflict(state, conflict);

		expect(next.settings).toEqual(conflict.currentSettings);
		expect(next.selectedProfileId).toBe(1);
		expect(next.draft).toEqual(draft);
		expect(next.credentialDraft).toBe("replacement-secret");
		expect(next.conflict).toEqual(conflict);
		expect(state.settings.revision).toBe(3);
	});
});

describe("copyDraft", () => {
	test("projects a complete profile without server-only fields", () => {
		const profile = {
			id: 7,
			displayName: "DeepSeek",
			apiFormat: "chat-completions" as const,
			requestUrl: "https://api.deepseek.com/v1/",
			modelsUrl: "https://api.deepseek.com/models",
			modelBackend: "ai-sdk" as const,
			adapter: "deepseek" as const,
			outputTokenRepresentation: "automatic" as const,
			timeoutMs: 120_000,
			pinnedModels: ["deepseek-chat"],
			discoveryCatalog: ["deepseek-chat", "deepseek-reasoner"],
			credentialConfigured: true,
			headers: [{ name: "X-Client", configured: true }],
		};

		expect(copyDraft(profile)).toEqual({
			displayName: "DeepSeek",
			apiFormat: "chat-completions",
			requestUrl: "https://api.deepseek.com/v1/",
			modelsUrl: "https://api.deepseek.com/models",
			modelBackend: "ai-sdk",
			adapter: "deepseek",
			outputTokenRepresentation: "automatic",
			timeoutMs: 120_000,
			pinnedModels: ["deepseek-chat"],
		});
	});
});
