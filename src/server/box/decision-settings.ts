import type { Database } from "bun:sqlite";
import { Value } from "@sinclair/typebox/value";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { boxReference, type BoxDecisionSettings, type BoxDecisionSettingsCommand, type DigestBoxId } from "../../shared/contract/box";
import { DEFAULT_DECISION_STATE_TOKEN_LIMIT, decisionSelection, type DecisionSelection } from "../../shared/contract/decision-model";
import { libraryDataTable } from "../database/schema";
import { tryResolveDecisionSelection, validateDecisionSelection } from "../decision-model";
import { guardRevision } from "../revision";

// @approved
//  A digesting Box's global Decision Model selection, kept in library_data.
// Without one the Box digests nothing.
const DECISION_KEY = "decision";
const unselected: DecisionSelection = { decisionProfileId: null, decisionModel: "", decisionStateTokenLimit: DEFAULT_DECISION_STATE_TOKEN_LIMIT };

const where = (id: DigestBoxId) => and(eq(libraryDataTable.namespace, boxReference(id)), eq(libraryDataTable.key, DECISION_KEY));

export const readBoxDecisionSettings = (database: Database, id: DigestBoxId): BoxDecisionSettings => {
	const row = drizzle(database).select().from(libraryDataTable).where(where(id)).get();
	if (row === undefined) return { ...unselected, revision: 0 };
	const selection: unknown = JSON.parse(row.value);
	if (!Value.Check(decisionSelection, selection)) throw new Error(`The stored ${id} Decision Model selection does not match its schema. Clear the ${boxReference(id)} namespace.`);
	return { ...selection, revision: row.revision };
};

export const applyBoxDecisionSettings = (database: Database, id: DigestBoxId, { expectedRevision, decisionProfileId, decisionModel, decisionStateTokenLimit }: BoxDecisionSettingsCommand): BoxDecisionSettings =>
	database.transaction(() => {
		const current = readBoxDecisionSettings(database, id);
		guardRevision("settings", expectedRevision, current, () => current);
		validateDecisionSelection(database, { decisionProfileId, decisionModel, decisionStateTokenLimit });
		const value = JSON.stringify({ decisionProfileId, decisionModel: decisionModel.trim(), decisionStateTokenLimit });
		const revision = current.revision + 1;
		drizzle(database).insert(libraryDataTable)
			.values({ namespace: boxReference(id), key: DECISION_KEY, value, revision })
			.onConflictDoUpdate({ target: [libraryDataTable.namespace, libraryDataTable.key], set: { value, revision } })
			.run();
		return readBoxDecisionSettings(database, id);
	}).immediate();

export const resolveBoxDecision = (database: Database, id: DigestBoxId) => tryResolveDecisionSelection(database, readBoxDecisionSettings(database, id));
