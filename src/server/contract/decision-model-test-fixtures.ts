import type { Database } from "bun:sqlite";
import { createConnectionSettingsModule } from "../connection-settings";
import { createMemorySettingsModule } from "../memory/settings";
import { createSemanticTriggerSettingsModule } from "../lorebook/semantic-settings";
import { blankConnectionProfileDraft } from "../../shared/contract/connection-settings";

export const configureDecisionModels = (database: Database, masterKey?: Uint8Array, model = "jev-1.13.0") => {
	const connections = createConnectionSettingsModule(database, { masterKey });
	const displayName = "Decision test";
	const created = connections.createProfile({ expectedRevision: connections.get().revision, profile: { ...blankConnectionProfileDraft, displayName, apiFormat: "system-one", requestUrl: "http://decision.test/v1/", timeoutMs: 15000 }, credential: "decision-secret" }).profiles.find(profile => profile.displayName === displayName)!;
	const selection = { decisionProfileId: created.id, decisionModel: model, decisionStateTokenLimit: 16000 };
	const memory = createMemorySettingsModule(database);
	const { revision, ...settings } = memory.get();
	memory.apply({ ...settings, ...selection, expectedRevision: revision });
	const semantic = createSemanticTriggerSettingsModule(database);
	semantic.apply({ type: "apply", expectedRevision: semantic.get().revision, ...selection, triggerThreshold: 0.5 });
	return selection;
};
