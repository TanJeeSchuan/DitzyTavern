import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { modelSelection, type ModelSelectionCommand, type ModelSelection } from "../shared/contract/model-selection";
import { putNamespacedLibraryValue, readNamespacedLibraryValue } from "./box/stored-value";
import { readProfileApiFormat } from "./connection-settings/persistence";
import { InvalidSettingsError } from "./revisioned-settings";
import { guardRevision } from "./revision";

export const createModelSelectionSettings = ({ namespace, key, apiFormat, label }: {
	namespace: string;
	key: string;
	apiFormat: "images" | "chat-completions";
	label: string;
}) => {
	const unselected: ModelSelection = { profileId: null, model: "" };
	const read = (database: Database) => readNamespacedLibraryValue(drizzle(database), namespace, key, modelSelection, unselected);
	const apply = (database: Database, { expectedRevision, profileId, model }: ModelSelectionCommand) => database.transaction(() => {
		if (profileId !== null && readProfileApiFormat(drizzle(database), profileId) !== apiFormat) throw new InvalidSettingsError(`Choose a ${apiFormat === "images" ? "Images" : "Chat Completions"} connection for the ${label}.`);
		if (profileId !== null && !model.trim()) throw new InvalidSettingsError(`Choose a ${label}.`);
		putNamespacedLibraryValue(drizzle(database), namespace, { key, value: JSON.stringify({ profileId, model: profileId === null ? "" : model.trim() }) },
			(current) => guardRevision("settings", expectedRevision, current, () => read(database)));
		return read(database);
	}).immediate();
	return { read, apply };
};
