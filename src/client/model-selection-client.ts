import { api } from "./lib/eden";
import { requestData, requestOutcome } from "./lib/request-outcome";
import { modelSelectionSettings, modelSelectionApplied, modelSelectionErrors, type ModelSelectionCommand } from "../shared/contract/model-selection";

export const modelSelectionClient = (route: "image-model" | "describing-model") => ({
	load: () => requestData(api.api[route].get(), modelSelectionSettings),
	save: (command: ModelSelectionCommand) => requestOutcome(api.api[route].commands.post(command), modelSelectionApplied, modelSelectionErrors),
});
