import { api } from "./lib/eden";
import { requestData, requestOutcome } from "./lib/request-outcome";
import { modelSelectionSettings, modelSelectionApplied, modelSelectionErrors, type ModelSelectionCommand } from "../shared/contract/model-selection";

export const loadDescribingModel = () => requestData(api.api["describing-model"].get(), modelSelectionSettings);
export const saveDescribingModel = (command: ModelSelectionCommand) => requestOutcome(api.api["describing-model"].commands.post(command), modelSelectionApplied, modelSelectionErrors);
