import type { Database } from "bun:sqlite";
import { createConnectionSettingsModule } from "../connection-settings";
import { createMemorySettingsModule } from "../memory/settings";
import { createSemanticTriggerSettingsModule } from "../lorebook/semantic-settings";
import type { ConnectionProfileDraft, ConnectionHeaderOperation } from "../connection-settings/types";
import { DEFAULT_DECISION_STATE_TOKEN_LIMIT } from "../../shared/contract/decision-model";
import { blankConnectionProfileDraft } from "../../shared/contract/connection-settings";

export const configureDecisionModels = (database: Database, masterKey?: Uint8Array, model = "jev-1.13.0",
	options: { profile?: Partial<ConnectionProfileDraft>; credential?: string; headers?: ConnectionHeaderOperation[];
	stateTokenLimit?: number } = {}) => {
	const connections = createConnectionSettingsModule(database, { masterKey });
	const profile = { ...blankConnectionProfileDraft, displayName: "Decision test", apiFormat: "system-one" as const, requestUrl: "http://decision.test/v1/", timeoutMs: 15000, ...options.profile };
	const created = connections.createProfile({ expectedRevision: connections.get().revision, profile,
		credential: options.credential ?? "decision-secret", headers: options.headers }).profiles.find(saved => saved.displayName === profile.displayName)!;
	const selection = { decisionProfileId: created.id, decisionModel: model, decisionStateTokenLimit: options.stateTokenLimit ?? DEFAULT_DECISION_STATE_TOKEN_LIMIT };
	const memory = createMemorySettingsModule(database);
	const { revision, ...settings } = memory.get();
	memory.apply({ ...settings, ...selection, expectedRevision: revision });
	const semantic = createSemanticTriggerSettingsModule(database);
	semantic.apply({ type: "apply", expectedRevision: semantic.get().revision, ...selection, triggerThreshold: 0.5 });
	return selection;
};
