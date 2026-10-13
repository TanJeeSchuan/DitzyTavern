import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { type BoxDecisionSettings, type BoxDecisionSettingsCommand, type DigestBoxId } from "../../shared/contract/box";
import { DEFAULT_DECISION_STATE_TOKEN_LIMIT, decisionSelection, type DecisionSelection } from "../../shared/contract/decision-model";
import { putLibraryValue, readLibraryValue } from "./stored-value";
import { tryResolveDecisionSelection, validateDecisionSelection } from "../decision-model";
import { guardRevision } from "../revision";

// @approved
//  A digesting Box's global Decision Model selection, kept in library_data
// under the host's own namespace and keyed by Box id, so a Box's own data in
// `box:<id>` can never reach it. Without one the Box digests nothing.
const NAMESPACE = "box-decision";
const unselected: DecisionSelection = { decisionProfileId: null, decisionModel: "", decisionStateTokenLimit: DEFAULT_DECISION_STATE_TOKEN_LIMIT };

export const readBoxDecisionSettings = (database: Database, id: DigestBoxId): BoxDecisionSettings =>
	readLibraryValue(drizzle(database), NAMESPACE, id, decisionSelection, unselected);

export const applyBoxDecisionSettings = (database: Database, id: DigestBoxId, { expectedRevision, decisionProfileId, decisionModel, decisionStateTokenLimit }: BoxDecisionSettingsCommand): BoxDecisionSettings =>
	database.transaction(() => {
		validateDecisionSelection(database, { decisionProfileId, decisionModel, decisionStateTokenLimit });
		const value = JSON.stringify({ decisionProfileId, decisionModel: decisionModel.trim(), decisionStateTokenLimit });
		putLibraryValue(drizzle(database), NAMESPACE, id, value, (current) => guardRevision("settings", expectedRevision, current, () => readBoxDecisionSettings(database, id)));
		return readBoxDecisionSettings(database, id);
	}).immediate();

export const resolveBoxDecision = (database: Database, id: DigestBoxId) => tryResolveDecisionSelection(database, readBoxDecisionSettings(database, id));
