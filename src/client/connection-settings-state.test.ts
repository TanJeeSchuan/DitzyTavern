import { describe, expect, test } from "bun:test";
import type { ConnectionProfile, ConnectionPreset } from "./connection-settings";
import type { ConnectionSettingsControllerState } from "./connection-settings-state";
import {
	copyDraft,
	createConnectionSettingsControllerState,
	emptyConnectionProfileDraft,
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

const controllerSettings = {
	revision: 2,
	profiles: [profile(1, "First"), profile(2, "Second", ["second-model"])],
};

const controllerState = (): ConnectionSettingsControllerState => ({
	...createConnectionSettingsControllerState(),
	settings: controllerSettings,
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

describe("reduceConnectionSettingsController", () => {
	test("loads settings onto the connection list without opening an editor", () => {
		const next = reduceConnectionSettingsController(
			createConnectionSettingsControllerState(),
			{ type: "load-succeeded", settings: controllerSettings, presets: [preset] },
		);

		expect(next.settings).toBe(controllerSettings);
		expect(next.presets).toEqual([preset]);
		expect(next.selectedProfileId).toBeNull();
		expect(next.editorOpen).toBe(false);
	});

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

	test("a command conflict replaces authority while retaining the local editor", () => {
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

		expect(next.settings).toBe(conflict.currentSettings);
		expect(next.conflict).toBe(conflict);
		expect(next.draft.displayName).toBe("Local edit");
		expect(next.credentialDraft).toBe("secret");
		expect(next.selectedProfileId).toBe(1);
		expect(next.error).toBe("Connection Settings changed elsewhere.");
	});

	test("deleting a profile adopts the new settings and clears the pending deletion", () => {
		const settings = { revision: 3, profiles: [profile(2, "Second")] };
		const next = reduceConnectionSettingsController(controllerState(), {
			type: "delete-succeeded",
			settings,
			deletedDisplayName: "First",
			editorVersion: 0,
			commandId: 0,
		});

		expect(next.settings).toBe(settings);
		expect(next.pendingDeletionProfileId).toBeNull();
		expect(next.notice).toBe("First deleted.");
	});

	test("late save results preserve a newer profile draft", () => {
		const editing = reduceConnectionSettingsController(controllerState(), {
			type: "set-draft",
			draft: { ...emptyConnectionProfileDraft, displayName: "Newer local edit" },
		});
		const next = reduceConnectionSettingsController(editing, {
			type: "apply-succeeded",
			settings: {
				revision: 3,
				profiles: [profile(1, "Older saved edit"), profile(2, "Second")],
			},
			selectedProfileId: 1,
			draftDisplayName: "Local edit",
			credentialWasProvided: false,
			editorVersion: 0,
			commandId: 0,
		});

		expect(next.settings?.revision).toBe(3);
		expect(next.selectedProfileId).toBe(1);
		expect(next.draft.displayName).toBe("Newer local edit");
		expect(next.notice).toBe(editing.notice);
	});

	test("a stale completion cannot replace newer server settings", () => {
		const refreshed = reduceConnectionSettingsController(controllerState(), {
			type: "refresh-succeeded",
			settings: { revision: 4, profiles: [profile(1, "Fresh"), profile(2, "Second")] },
			notice: "refreshed",
		});
		const next = reduceConnectionSettingsController(refreshed, {
			type: "apply-succeeded",
			settings: { revision: 3, profiles: [profile(1, "Stale")] },
			selectedProfileId: 1,
			draftDisplayName: "Local edit",
			credentialWasProvided: false,
			editorVersion: 0,
			commandId: 0,
		});

		expect(next.settings?.revision).toBe(4);
		expect(next.settings?.profiles[0]?.displayName).toBe("Fresh");
		expect(next.draft.displayName).toBe("Local edit");
	});

});
