import { api } from "./lib/eden";
import { requestData } from "./lib/request-outcome";
import { requestOutcome } from "./lib/request-route-outcome";
import { modelSelectionCommandResponse, modelSelectionReadResponse, type ModelSelectionCommand } from "../shared/contract/model-selection";

export const modelSelectionClient = (route: "image-model" | "describing-model") => ({
	load: () => requestData(api.api[route].get(), modelSelectionReadResponse[200]),
	save: (command: ModelSelectionCommand) => requestOutcome(api.api[route].commands.post(command), modelSelectionCommandResponse),
});
