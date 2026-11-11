import { api } from "./lib/eden";
import { requestData, requestOutcome } from "./lib/request-outcome";
import { modelSelectionSettings, modelSelectionApplied, modelSelectionErrors, type ModelSelectionCommand } from "../shared/contract/model-selection";

export const loadImageModel = () => requestData(api.api["image-model"].get(), modelSelectionSettings);
export const saveImageModel = (command: ModelSelectionCommand) => requestOutcome(api.api["image-model"].commands.post(command), modelSelectionApplied, modelSelectionErrors);
