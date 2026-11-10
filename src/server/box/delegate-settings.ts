import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { DEFAULT_BOX_DELEGATE, boxDelegateSelection, type BoxDelegateSettings, type BoxDelegateSettingsCommand, type BoxId } from "../../shared/contract/box";
import { resolveLibfxProvider } from "../authoring/provider";
import { readProfileApiFormat } from "../connection-settings/persistence";
import { InvalidSettingsError } from "../revisioned-settings";
import { guardRevision } from "../revision";
import { putNamespacedLibraryValue, readNamespacedLibraryValue } from "./stored-value";

// @approved
//  A delegating Box's global delegate setting, kept in library_data under the
// host's own namespace and keyed by Box id, beside the Decision Model
// selections and apart from the Box's own `box:<id>` data. A Box without
// its own profile inherits the host default, whose key cannot be a Box id.
const NAMESPACE = "box-delegate";

export const readBoxDelegateSettings = (database: Database, id: BoxId): BoxDelegateSettings =>
	readNamespacedLibraryValue(drizzle(database), NAMESPACE, id, boxDelegateSelection, { profileId: null, model: "" });

/** @approved Execution uses the Box's own selection when present, otherwise the host default. Editing reads only the stored selection. */
export const readEffectiveBoxDelegateSettings = (database: Database, id: BoxId): BoxDelegateSettings => {
	const own = readBoxDelegateSettings(database, id);
	return own.profileId === null ? readBoxDelegateSettings(database, DEFAULT_BOX_DELEGATE) : own;
};

export const applyBoxDelegateSettings = (database: Database, id: BoxId, { expectedRevision, profileId, model }: BoxDelegateSettingsCommand): BoxDelegateSettings =>
	database.transaction(() => {
		const chosen = model.trim();
		if (profileId === null && chosen !== "") throw new InvalidSettingsError("Choose a Connection Profile before setting the delegate's model.");
		if (profileId !== null && readProfileApiFormat(drizzle(database), profileId) !== "chat-completions") throw new InvalidSettingsError("Choose a Chat Completions connection for the delegate.");
		if (profileId !== null && chosen === "") throw new InvalidSettingsError("Choose a model for the delegate.");
		const value = JSON.stringify({ profileId, model: chosen });
		putNamespacedLibraryValue(drizzle(database), NAMESPACE, { key: id, value }, (current) => guardRevision("settings", expectedRevision, current, () => readBoxDelegateSettings(database, id)));
		return readBoxDelegateSettings(database, id);
	}).immediate();

// @approved
//  The delegate setting as a run uses it: off without a profile, or libfx's
// options for it, or broken with the reason, through the same resolution
// Creator Mode's coding agent takes.
export const resolveBoxDelegate = (database: Database, id: BoxId) => {
	const { profileId, model } = readEffectiveBoxDelegateSettings(database, id);
	if (profileId === null) return { kind: "off" } as const;
	const mapped = resolveLibfxProvider(database, { profileId, model });
	return mapped.outcome === "refused" ? { kind: "broken", reason: mapped.reason } as const : { kind: "ready", options: mapped.options } as const;
};
