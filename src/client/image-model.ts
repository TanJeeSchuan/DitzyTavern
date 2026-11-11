import { api } from "./lib/eden";
import { requestData, requestOutcome } from "./lib/request-outcome";
import { imageModelSettings, imageModelApplied, imageModelErrors, type ImageModelCommand } from "../shared/contract/image-model";

export const loadImageModel = () => requestData(api.api["image-model"].get(), imageModelSettings);
export const saveImageModel = (command: ImageModelCommand) => requestOutcome(api.api["image-model"].commands.post(command), imageModelApplied, imageModelErrors);
