import { api } from "./lib/eden";
import { requestData, requestOutcome } from "./lib/request-outcome";
import {
	boxDecisionSettings, boxDecisionSettingsApplied, boxDecisionSettingsCommandErrors, boxDelegateSettings, boxDelegateSettingsApplied, boxDelegateSettingsCommandErrors, installedBoxes,
	type BoxDecisionSettings, type BoxDecisionSettingsCommand, type BoxDelegateSettings, type BoxDelegateSettingsCommand, type BoxId,
} from "../shared/contract/box";

const route = (box: BoxId) => api.api.boxes({ box })["decision-settings"];

// @approved
//  One load and save pair per digesting Box, built once, after startup
// installs the descriptors, so a settings draft keyed by them never reloads
// on render.
let clients: ReturnType<typeof buildClients> | undefined;
export const boxDecisionClients = () => clients ??= buildClients();
const buildClients = () => [...installedBoxes().values()].flatMap(({ metadata: { id: box, label, decision } }) => decision === undefined ? [] : [{
	box,
	label,
	decision,
	load: (): Promise<BoxDecisionSettings> => requestData(route(box).get(), boxDecisionSettings),
	save: (command: BoxDecisionSettingsCommand) => requestOutcome(route(box).commands.post(command), boxDecisionSettingsApplied, boxDecisionSettingsCommandErrors),
}]);

const delegateRoute = (box: BoxId) => api.api.boxes({ box })["delegate-settings"];
/** @approved One load and save pair per delegating Box, built once, as the Decision Model pairs are. */
let delegates: ReturnType<typeof buildDelegates> | undefined;
export const boxDelegateClients = () => delegates ??= buildDelegates();
const buildDelegates = () => [...installedBoxes().values()].flatMap(({ metadata: { id: box, label, delegate } }) => delegate === undefined ? [] : [{
	box,
	label,
	delegate,
	load: (): Promise<BoxDelegateSettings> => requestData(delegateRoute(box).get(), boxDelegateSettings),
	save: (command: BoxDelegateSettingsCommand) => requestOutcome(delegateRoute(box).commands.post(command), boxDelegateSettingsApplied, boxDelegateSettingsCommandErrors),
}]);
