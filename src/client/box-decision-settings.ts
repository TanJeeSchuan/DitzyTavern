import { api } from "./lib/eden";
import { requestData, requestOutcome } from "./lib/request-outcome";
import {
	boxDecisionSettings, boxDecisionSettingsApplied, boxDecisionSettingsCommandErrors, boxDelegateSettings, boxDelegateSettingsApplied, boxDelegateSettingsCommandErrors, installedBoxes,
	type BoxDecisionSettings, type BoxDecisionSettingsCommand, type BoxDelegateSettings, type BoxDelegateSettingsCommand, type BoxId, type BoxMetadata,
} from "../shared/contract/box";

const route = (box: BoxId) => api.api.boxes({ box })["decision-settings"];

// @approved
//  One load and save pair per digesting or delegating Box, built once per Box
// and kept while the catalog lists it, so a settings draft keyed by them
// never reloads on render, and a Box installed while the app runs joins the
// list once the catalog is installed again.
const kept = <Client>(build: (metadata: BoxMetadata) => Client | undefined) => {
	const clients = new Map<BoxId, Client>();
	let catalog: ReturnType<typeof installedBoxes> | undefined;
	let listed: Client[] = [];
	return () => {
		if (catalog === installedBoxes()) return listed;
		catalog = installedBoxes();
		listed = [...catalog.values()].flatMap(({ metadata }) => {
			const client = clients.get(metadata.id) ?? build(metadata);
			if (client !== undefined) clients.set(metadata.id, client);
			return client === undefined ? [] : [client];
		});
		return listed;
	};
};
export const boxDecisionClients = kept(({ id: box, label, decision }) => decision && {
	box,
	label,
	decision,
	load: (): Promise<BoxDecisionSettings> => requestData(route(box).get(), boxDecisionSettings),
	save: (command: BoxDecisionSettingsCommand) => requestOutcome(route(box).commands.post(command), boxDecisionSettingsApplied, boxDecisionSettingsCommandErrors),
});

const delegateRoute = (box: BoxId) => api.api.boxes({ box })["delegate-settings"];
export const boxDelegateClients = kept(({ id: box, label, delegate }) => delegate && {
	box,
	label,
	delegate,
	load: (): Promise<BoxDelegateSettings> => requestData(delegateRoute(box).get(), boxDelegateSettings),
	save: (command: BoxDelegateSettingsCommand) => requestOutcome(delegateRoute(box).commands.post(command), boxDelegateSettingsApplied, boxDelegateSettingsCommandErrors),
});
