import { describe, expect, test } from "bun:test";
import type { ConnectionSettingsEditorState } from "./connection-settings-state";
import { preserveConnectionDraftOnConflict } from "./connection-settings-state";

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
