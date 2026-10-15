// @approved
//  Removes the avatars `db:seed:race-avatars` set. Run with
// `bun run db:teardown:race-avatars`. A row goes only when it still holds the
// exact Image its folder file produces, so an avatar the writer replaced
// stays. The Images themselves are left to the orphan sweep.

import { drizzle } from "drizzle-orm/bun-sqlite";
import { RACE_AVATAR_PREFIX } from "./shared-data";
import { deleteLibraryValue, ingestImage, openInitializedDatabase } from "@/box-sdk/server";
import { RACE_AVATAR_FOLDER, raceAvatarFiles } from "./server-seed-avatars";

export async function teardownRaceAvatars(databasePath?: string, folder?: string) {
	const database = openInitializedDatabase({ path: databasePath });
	try {
		let removed = 0;
		for (const { name, path } of raceAvatarFiles(folder)) {
			const { hash } = await ingestImage(await Bun.file(path).bytes());
			removed += deleteLibraryValue(drizzle(database), "race", { key: `${RACE_AVATAR_PREFIX}${name}`, value: hash });
		}
		console.log(`[teardown:race-avatars] removed ${removed} avatars matching ${folder ?? RACE_AVATAR_FOLDER}/`);
	} finally {
		database.close();
	}
}

if (import.meta.main) await teardownRaceAvatars(Bun.argv[2], Bun.argv[3]);
