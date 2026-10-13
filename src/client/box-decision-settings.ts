import { api } from "./lib/eden";
import { requestData, requestOutcome } from "./lib/request-outcome";
import { boxDecisionSettings, boxDecisionSettingsApplied, boxDecisionSettingsCommandErrors, boxDescriptor, boxesWith, type BoxDecisionSettings, type BoxDecisionSettingsCommand, type BoxId } from "../shared/contract/box";

const route = (box: BoxId) => api.api.boxes({ box })["decision-settings"];

// @approved
//  One load and save pair per digesting Box, built once, after startup
// installs the descriptors, so a settings draft keyed by them never reloads
// on render.
let clients: ReturnType<typeof buildClients> | undefined;
export const boxDecisionClients = () => clients ??= buildClients();
const buildClients = () => boxesWith("decision").map(([box, decision]) => ({
	box,
	label: boxDescriptor(box).label,
	decision,
	load: (): Promise<BoxDecisionSettings> => requestData(route(box).get(), boxDecisionSettings),
	save: (command: BoxDecisionSettingsCommand) => requestOutcome(route(box).commands.post(command), boxDecisionSettingsApplied, boxDecisionSettingsCommandErrors),
}));
