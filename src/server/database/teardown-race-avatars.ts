// @approved
//  Removes the avatars `db:seed:race-avatars` set. Run with
// `bun run db:teardown:race-avatars`. A row goes only when it still holds the
// exact Image its folder file produces, so an avatar the writer replaced
// stays. The Images themselves are left to the orphan sweep.

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { boxReference } from "../../shared/contract/box";
import { RACE_AVATAR_PREFIX } from "../../shared/race-data";
import { ingestImage } from "../image/ingest";
import { openInitializedDatabase } from "./database";
import { libraryDataTable } from "./schema";
import { RACE_AVATAR_FOLDER, raceAvatarFiles } from "./seed-race-avatars";

export async function teardownRaceAvatars(databasePath?: string, folder?: string) {
	const database = openInitializedDatabase({ path: databasePath });
	try {
		let removed = 0;
		for (const { name, path } of raceAvatarFiles(folder)) {
			const { hash } = await ingestImage(await Bun.file(path).bytes());
			removed += drizzle(database).delete(libraryDataTable).where(and(
				eq(libraryDataTable.namespace, boxReference("race")), eq(libraryDataTable.key, `${RACE_AVATAR_PREFIX}${name}`), eq(libraryDataTable.value, hash),
			)).returning().all().length;
		}
		console.log(`[teardown:race-avatars] removed ${removed} avatars matching ${folder ?? RACE_AVATAR_FOLDER}/`);
	} finally {
		database.close();
	}
}

if (import.meta.main) await teardownRaceAvatars();
