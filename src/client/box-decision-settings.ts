import { api } from "./lib/eden";
import { requestData, requestOutcome } from "./lib/request-outcome";
import { boxDecisionSettings, boxDecisionSettingsApplied, boxDecisionSettingsCommandErrors, digestBoxIds, type BoxDecisionSettings, type BoxDecisionSettingsCommand, type DigestBoxId } from "../shared/contract/box";

const route = (box: DigestBoxId) => api.api.boxes({ box })["decision-settings"];

// @approved
//  One load and save pair per digesting Box, built once so a settings draft
// keyed by them never reloads on render.
export const boxDecisionClients = digestBoxIds.map((box) => ({
	box,
	load: (): Promise<BoxDecisionSettings> => requestData(route(box).get(), boxDecisionSettings),
	save: (command: BoxDecisionSettingsCommand) => requestOutcome(route(box).commands.post(command), boxDecisionSettingsApplied, boxDecisionSettingsCommandErrors),
}));
