import { api } from "./lib/eden";
import { requestData, requestOutcome } from "./lib/request-outcome";
import { boxDecisionSettings, boxDecisionSettingsApplied, boxDecisionSettingsCommandErrors, type BoxDecisionSettings, type BoxDecisionSettingsCommand } from "../shared/contract/box";

const worldClock = () => api.api.boxes({ box: "world-clock" })["decision-settings"];

export const loadWorldClockDecisionSettings = (): Promise<BoxDecisionSettings> => requestData(worldClock().get(), boxDecisionSettings);

export const saveWorldClockDecisionSettings = (command: BoxDecisionSettingsCommand) =>
	requestOutcome(worldClock().commands.post(command), boxDecisionSettingsApplied, boxDecisionSettingsCommandErrors);
