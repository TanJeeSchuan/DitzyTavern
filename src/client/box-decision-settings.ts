import { api } from "./lib/eden";
import { requestData, requestOutcome } from "./lib/request-outcome";
import {
	DEFAULT_BOX_DELEGATE, boxDecisionSettings, boxDecisionSettingsApplied, boxDecisionSettingsCommandErrors, boxDelegateSettings, boxDelegateSettingsApplied, boxDelegateSettingsCommandErrors, installedBoxes,
	type BoxDecisionSettings, type BoxDecisionSettingsCommand, type BoxDelegateSettings, type BoxDelegateSettingsCommand, type BoxId, type BoxMetadata,
} from "../shared/contract/box";

const route = (box: BoxId) => api.api.boxes({ box })["decision-settings"];

// @approved
//  One load and save pair per digesting or delegating Box, built once per Box
// and kept while the catalog lists it, so a settings draft keyed by them
// never reloads on render. What the settings show, the label and the copy,
// is read from the catalog each time it is installed again, so a Box
// installed while the app runs joins the list and a new version's copy
// shows.
const kept = <Shown, Io>(shown: (metadata: BoxMetadata) => Shown | undefined, io: (box: BoxId) => Io) => {
	const ios = new Map<BoxId, Io>();
	let catalog: ReturnType<typeof installedBoxes> | undefined;
	let listed: (Shown & Io & { readonly box: BoxId; readonly label: string })[] = [];
	return () => {
		if (catalog === installedBoxes()) return listed;
		catalog = installedBoxes();
		listed = [...catalog.values()].flatMap(({ metadata }) => {
			const presented = shown(metadata);
			if (presented === undefined) return [];
			const functions = ios.get(metadata.id) ?? io(metadata.id);
			ios.set(metadata.id, functions);
			return [{ box: metadata.id, label: metadata.label, ...presented, ...functions }];
		});
		return listed;
	};
};
export const boxDecisionClients = kept(({ decision }) => decision && { decision }, (box) => ({
	load: (): Promise<BoxDecisionSettings> => requestData(route(box).get(), boxDecisionSettings),
	save: (command: BoxDecisionSettingsCommand) => requestOutcome(route(box).commands.post(command), boxDecisionSettingsApplied, boxDecisionSettingsCommandErrors),
}));

const delegateRoute = (box: BoxId) => api.api.boxes({ box })["delegate-settings"];
const delegateClient = (box: BoxId) => ({
	load: (): Promise<BoxDelegateSettings> => requestData(delegateRoute(box).get(), boxDelegateSettings),
	save: (command: BoxDelegateSettingsCommand) => requestOutcome(delegateRoute(box).commands.post(command), boxDelegateSettingsApplied, boxDelegateSettingsCommandErrors),
});
export const defaultDelegateClient = delegateClient(DEFAULT_BOX_DELEGATE);
export const boxDelegateClients = kept(({ delegate }) => delegate && { delegate }, delegateClient);
