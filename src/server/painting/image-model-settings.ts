import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { imageModelSelection, type ImageModelCommand, type ImageModelSelection } from "../../shared/contract/image-model";
import { putNamespacedLibraryValue, readNamespacedLibraryValue } from "../box/stored-value";
import { createConnectionSettingsModule } from "../connection-settings";
import { InvalidConversationCommandError } from "../conversation";
import { guardRevision } from "../revision";

const NAMESPACE = "painting";
const unselected: ImageModelSelection = { profileId: null, model: "" };
export const readImageModelSettings = (database: Database) => readNamespacedLibraryValue(drizzle(database), NAMESPACE, "image-model", imageModelSelection, unselected);

export const applyImageModelSettings = (database: Database, { expectedRevision, profileId, model }: ImageModelCommand) => database.transaction(() => {
	if (profileId !== null && (!model.trim() || createConnectionSettingsModule(database).get().profiles.find((profile) => profile.id === profileId)?.apiFormat !== "images")) throw new InvalidConversationCommandError("Choose an Images connection and Image Model.");
	putNamespacedLibraryValue(drizzle(database), NAMESPACE, { key: "image-model", value: JSON.stringify({ profileId, model: profileId === null ? "" : model.trim() }) }, (current) => guardRevision("settings", expectedRevision, current, () => readImageModelSettings(database)));
	return readImageModelSettings(database);
}).immediate();
