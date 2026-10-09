import { describe, expect, test } from "bun:test";
import type { ConnectionProfile, ConnectionPreset } from "./connection-settings";
import type { ConnectionSettingsControllerState } from "./connection-settings-state";
import {
	copyDraft,
	createConnectionSettingsControllerState,
	emptyConnectionProfileDraft,
	headerEditorDataFor,
	newerSettings,
	reduceConnectionSettingsController,
} from "./connection-settings-state";

const profile = (id: number, displayName: string, pinnedModels: string[] = ["model"]): ConnectionProfile => ({
	id,
	displayName,
	apiFormat: "chat-completions",
	requestUrl: `https://${displayName.toLowerCase()}.example/`,
	modelsUrl: "",
	modelBackend: "automatic",
	adapter: "openai-compatible",
	outputTokenRepresentation: "automatic",
	timeoutMs: 120_000,
	pinnedModels,
	discoveryCatalog: [...pinnedModels, "discovered-model"],
	textOnlyModels: [],
	credentialConfigured: true,
	headers: [{ name: "X-Client", configured: true }],
});

const preset: ConnectionPreset = {
	id: "preset",
	label: "Preset",
	description: "Preset description",
	profile: {
		displayName: "Preset draft",
		apiFormat: "chat-completions",
		requestUrl: "https://preset.example/",
		modelsUrl: "",
		modelBackend: "automatic",
		adapter: "openai-compatible",
		outputTokenRepresentation: "automatic",
		timeoutMs: 120_000,
		pinnedModels: ["preset-model"],
	},
};

const controllerState = (): ConnectionSettingsControllerState => ({
	...createConnectionSettingsControllerState(),
	selectedProfileId: 1,
	draft: { ...emptyConnectionProfileDraft, displayName: "Local edit" },
	credentialDraft: "secret",
	headerEditorData: { "X-Client": { configured: true, operation: "replace", replacement: "local" } },
	testModelId: "local-model",
	testResult: { outcome: "available", value: { outcome: "success", message: "Connected." } },
	pendingDeletionProfileId: 1,
	notice: "old notice",
	error: "old error",
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

describe("newerSettings", () => {
	test("an older snapshot never replaces a newer one", () => {
		const older = { revision: 2, profiles: [profile(1, "Old")] };
		const newer = { revision: 4, profiles: [profile(1, "Fresh")] };

		expect(newerSettings(older, newer)).toBe(newer);
		expect(newerSettings(newer, older)).toBe(newer);
		expect(newerSettings(null, older)).toBe(older);
	});
});

describe("reduceConnectionSettingsController", () => {
	test("choosing a preset creates a clean new-profile draft", () => {
		const next = reduceConnectionSettingsController(controllerState(), {
			type: "choose-preset",
			preset,
		});

		expect(next.selectedProfileId).toBeNull();
		expect(next.draft).toEqual(copyDraft(preset.profile));
		expect(next.credentialDraft).toBe("");
		expect(next.testModelId).toBe("preset-model");
		expect(next.headerEditorData).toEqual({});
		expect(next.pendingDeletionProfileId).toBeNull();
		expect(next.error).toBeNull();
	});

	test("choosing a blank preset opens the new-profile editor", () => {
		const next = reduceConnectionSettingsController(controllerState(), {
			type: "choose-preset",
			preset: { ...preset, profile: emptyConnectionProfileDraft },
		});

		expect(next.editorOpen).toBe(true);
	});

	test("a command conflict retains the local editor and surfaces the conflict", () => {
		const conflict = {
			outcome: "conflict" as const,
			expectedRevision: 2,
			actualRevision: 3,
			currentSettings: {
				revision: 3,
				profiles: [profile(2, "Authoritative")],
			},
		};
		const next = reduceConnectionSettingsController(controllerState(), {
			type: "command-conflict",
			conflict,
			message: "Connection Settings changed elsewhere.",
		});

		expect(next.conflict).toBe(conflict);
		expect(next.draft.displayName).toBe("Local edit");
		expect(next.credentialDraft).toBe("secret");
		expect(next.selectedProfileId).toBe(1);
		expect(next.error).toBe("Connection Settings changed elsewhere.");
	});

	test("deleting a profile clears the pending deletion and reports it", () => {
		const next = reduceConnectionSettingsController(controllerState(), {
			type: "delete-succeeded",
			deletedProfileId: 1,
			deletedDisplayName: "First",
		});

		expect(next.pendingDeletionProfileId).toBeNull();
		expect(next.conflict).toBeNull();
		expect(next.notice).toBe("First deleted.");
	});

	test("a late deletion result leaves another profile's deletion confirmation open", () => {
		const confirmingB = reduceConnectionSettingsController(controllerState(), { type: "request-deletion", profileId: 2 });
		const next = reduceConnectionSettingsController(confirmingB, {
			type: "delete-succeeded",
			deletedProfileId: 1,
			deletedDisplayName: "First",
		});

		expect(next.pendingDeletionProfileId).toBe(2);
		expect(next.notice).toBeNull();
	});

	test("a save result cannot adopt after editing A to B and back to A", () => {
		const submitted = controllerState();
		const changed = reduceConnectionSettingsController(submitted, {
			type: "set-draft", draft: { ...submitted.draft, displayName: "B" },
		});
		const restored = reduceConnectionSettingsController(changed, { type: "set-draft", draft: submitted.draft });
		const next = reduceConnectionSettingsController(restored, {
			type: "apply-succeeded",
			settings: { revision: 3, profiles: [profile(1, "Saved")] },
			draftDisplayName: "Local edit",
			submitted,
		});

		expect(next.draft.displayName).toBe("Local edit");
		expect(next.credentialDraft).toBe("secret");
		expect(next.notice).toBe("old notice");
	});

	test("a save result adopts the saved profile while the editor still matches", () => {
		const state = controllerState();
		const next = reduceConnectionSettingsController(state, {
			type: "apply-succeeded",
			settings: { revision: 3, profiles: [profile(1, "Saved"), profile(2, "Second")] },
			draftDisplayName: "Local edit",
			submitted: {
				selectedProfileId: 1,
				editorIdentity: state.editorIdentity,
			},
		});

		expect(next.draft).toEqual(copyDraft(profile(1, "Saved")));
		expect(next.headerEditorData).toEqual(headerEditorDataFor(profile(1, "Saved").headers));
		expect(next.credentialDraft).toBe("");
		expect(next.notice).toBe("Changes saved. No provider request was made.");
	});

	test("a save result preserves a draft the editor changed while saving", () => {
		const editing = reduceConnectionSettingsController(controllerState(), {
			type: "set-draft",
			draft: { ...emptyConnectionProfileDraft, displayName: "Newer local edit" },
		});
		const next = reduceConnectionSettingsController(editing, {
			type: "apply-succeeded",
			settings: { revision: 3, profiles: [profile(1, "Older saved edit"), profile(2, "Second")] },
			draftDisplayName: "Local edit",
			submitted: {
				selectedProfileId: 1,
				editorIdentity: Symbol(),
			},
		});

		expect(next.selectedProfileId).toBe(1);
		expect(next.draft.displayName).toBe("Newer local edit");
		expect(next.notice).toBe(editing.notice);
		expect(next.testResult).toBe(editing.testResult);
	});
});
