import type { Database } from "bun:sqlite";
import { semanticTriggerSettingsTable } from "../database/schema";
import { createRevisionedSettings, InvalidSettingsError } from "../revisioned-settings";
import { validateDecisionSelection } from "../decision-model";
import type { SemanticTriggerSettingsCommand, SemanticTriggerSettingsPayload } from "../../shared/contract/semantic-trigger-settings";

export const createSemanticTriggerSettingsModule = (database: Database) => {
	const settings = createRevisionedSettings(database, semanticTriggerSettingsTable,
		(value): SemanticTriggerSettingsPayload => ({ revision: value.revision, decisionProfileId: value.decision_profile_id,
		decisionModel: value.decision_model, decisionStateTokenLimit: value.decision_state_token_limit, triggerThreshold: value.trigger_threshold }));
	return {
		get: settings.get,
		apply: (command: SemanticTriggerSettingsCommand) => {
			validateDecisionSelection(database, command);
			if (!(command.triggerThreshold >= 0 && command.triggerThreshold <= 1)) throw new InvalidSettingsError("The trigger threshold must be between 0 and 1.");
			return settings.commit(command.expectedRevision, { decision_profile_id: command.decisionProfileId, decision_model: command.decisionModel.trim(),
				decision_state_token_limit: command.decisionStateTokenLimit, trigger_threshold: command.triggerThreshold });
		},
	};
};
