import { describe, expect, test } from "bun:test";
import type { ConnectionProfile, ConnectionPreset } from "./connection-settings";
import type { ConnectionSettingsControllerState, ProfileEdit } from "./connection-settings-state";
import {
	copyDraft,
	createConnectionSettingsControllerState,
	editIn,
	editOf,
	emptyConnectionProfileDraft,
	headerEditorDataFor,
	reduceConnectionSettingsController,
	testedEditor,
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
	systemPlacement: "strict",
	timeoutMs: 120_000,
	pinnedModels,
	discoveryCatalog: [...pinnedModels, "discovered-model"],
	textOnlyModels: [],
	credentialState: "saved",
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
		systemPlacement: "strict",
		timeoutMs: 120_000,
		pinnedModels: ["preset-model"],
	},
};

const localEdit: ProfileEdit = {
	draft: { ...emptyConnectionProfileDraft, displayName: "Local edit" },
	credentialDraft: "secret",
	headerEditorData: { "X-Client": { configured: true, operation: "replace", replacement: "local" } },
};
const controllerState = (): ConnectionSettingsControllerState => ({
	...createConnectionSettingsControllerState(),
	selectedProfileId: 1,
	session: { status: "dirty", base: { value: editOf(profile(1, "Saved")), revision: 2 }, mine: localEdit },
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
			systemPlacement: "strict" as const,
			timeoutMs: 120_000,
			pinnedModels: ["deepseek-chat"],
			discoveryCatalog: ["deepseek-chat", "deepseek-reasoner"],
			credentialState: "saved",
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
			systemPlacement: "strict",
			timeoutMs: 120_000,
			pinnedModels: ["deepseek-chat"],
		});
	});
});

describe("reduceConnectionSettingsController", () => {
	test("choosing a preset opens an unsaved new-profile draft", () => {
		const next = reduceConnectionSettingsController(controllerState(), { type: "choose-preset", preset, revision: 2 });
		const edit = editIn(next);

		expect(next.selectedProfileId).toBeNull();
		expect(next.session?.status).toBe("dirty");
		expect(edit.draft).toEqual(copyDraft(preset.profile));
		expect(edit.credentialDraft).toBe("");
		expect(edit.headerEditorData).toEqual({});
		expect(next.testModelId).toBe("preset-model");
		expect(next.pendingDeletionProfileId).toBeNull();
		expect(next.error).toBeNull();
	});

	test("choosing a blank preset opens the new-profile editor", () => {
		const next = reduceConnectionSettingsController(controllerState(), {
			type: "choose-preset",
			preset: { ...preset, profile: emptyConnectionProfileDraft },
			revision: 2,
		});

		expect(next.session).not.toBeNull();
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

	test("editing the draft clears a test result that no longer describes it", () => {
		const next = reduceConnectionSettingsController(controllerState(), { type: "set-credential-draft", value: "other secret" });

		expect(next.testResult).toBeNull();
	});

	test("a test result for an editor that changed meanwhile is dropped", () => {
		const testing = reduceConnectionSettingsController(controllerState(), { type: "test-started" });
		const edited = reduceConnectionSettingsController(testing, { type: "set-draft", draft: { ...editIn(testing).draft, requestUrl: "http://other.test" } });
		const next = reduceConnectionSettingsController(edited, {
			type: "test-succeeded",
			editor: testedEditor(testing),
			result: { outcome: "available", value: { outcome: "success", message: "Connected." } },
		});

		expect(next.testResult).toBeNull();
	});

	test("a save result adopts the saved profile while the editor still matches", () => {
		const saving = reduceConnectionSettingsController(controllerState(), { type: "apply-started", submitted: localEdit });
		const next = reduceConnectionSettingsController(saving, {
			type: "apply-succeeded",
			settings: { revision: 3, profiles: [profile(1, "Saved"), profile(2, "Second")] },
			submitted: localEdit,
		});
		const edit = editIn(next);

		expect(next.session?.status).toBe("clean");
		expect(edit.draft).toEqual(copyDraft(profile(1, "Saved")));
		expect(edit.headerEditorData).toEqual(headerEditorDataFor(profile(1, "Saved").headers));
		expect(edit.credentialDraft).toBe("");
		expect(next.notice).toBe("Changes saved. No provider request was made.");
	});

	test("a save result preserves a draft the editor changed while saving", () => {
		const saving = reduceConnectionSettingsController(controllerState(), { type: "apply-started", submitted: localEdit });
		const editing = reduceConnectionSettingsController(saving, {
			type: "set-draft",
			draft: { ...emptyConnectionProfileDraft, displayName: "Newer local edit" },
		});
		const next = reduceConnectionSettingsController(editing, {
			type: "apply-succeeded",
			settings: { revision: 3, profiles: [profile(1, "Older saved edit"), profile(2, "Second")] },
			submitted: localEdit,
		});

		expect(next.selectedProfileId).toBe(1);
		expect(next.session?.status).toBe("dirty");
		expect(editIn(next).draft.displayName).toBe("Newer local edit");
		expect(next.notice).toBe(editing.notice);
	});

	test("a conflict that left the Profile unchanged keeps the draft saveable at the newer revision", () => {
		const saving = reduceConnectionSettingsController(controllerState(), { type: "apply-started", submitted: localEdit });
		const next = reduceConnectionSettingsController(saving, {
			type: "apply-conflicted", submitted: localEdit, theirs: { value: editOf(profile(1, "Saved")), revision: 5 }, message: "Changed elsewhere.",
		});
		const followed = reduceConnectionSettingsController(next, { type: "observed", server: { value: editOf(profile(1, "Saved")), revision: 5 } });

		expect(followed.session?.status).toBe("dirty");
		expect(followed.session?.status === "dirty" && followed.session.base.revision).toBe(5);
	});
});
