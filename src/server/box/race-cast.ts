import { and, eq, inArray } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { Value } from "@sinclair/typebox/value";
import { boxReference } from "../../shared/contract/box";
import { raceStats, type RaceCastStats } from "../../shared/contract/race";
import { participantDataTable } from "../database/schema";

/** @approved
 * The Race window's stat-sheet read: each Cast Participant's own `box:race`
 * stats rows, decoded against the shared schema. A Participant without stats
 * is absent, and a stored value that no longer decodes is an error, never a
 * silently ignored row.
 */
export const readRaceCastStats = (
	db: BunSQLiteDatabase,
	participantIds: readonly number[],
): RaceCastStats[] =>
	participantIds.length === 0
		? []
		: db
				.select({
					participantId: participantDataTable.participant_id,
					value: participantDataTable.value,
				})
				.from(participantDataTable)
				.where(
					and(
						eq(participantDataTable.namespace, boxReference("race")),
						eq(participantDataTable.key, "stats"),
						inArray(participantDataTable.participant_id, [...participantIds]),
					),
				)
				.all()
				.map(({ participantId, value }) => {
					const stats: unknown = JSON.parse(value);
					if (!Value.Check(raceStats, stats)) {
						throw new Error(
							"A Participant's stored box:race stats do not match the Race stats schema. Clear the box:race namespace.",
						);
					}
					return { participantId, stats };
				});
