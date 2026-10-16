// @approved
//  Local roster avatars. Run with `bun run db:seed:race-avatars`.
// The repository ships no Runner art, so the images come from the gitignored
// `race-avatars/` folder, one file per roster Runner named after it, such as
// `race-avatars/Gold Ship.png`. A Runner that already has an avatar keeps it.

import { existsSync, readdirSync } from "node:fs";
import { join, parse } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { RACE_AVATAR_PREFIX, raceRoster } from "./shared-data";
import { boxReference, libraryDataTable, openInitializedDatabase, uploadImage } from "@/box-sdk/server";

export const RACE_AVATAR_FOLDER = "race-avatars";

export const raceAvatarFiles = (folder = RACE_AVATAR_FOLDER) => existsSync(folder)
	? readdirSync(folder).flatMap((file) => raceRoster.some(({ name }) => name === parse(file).name) ? [{ name: parse(file).name, path: join(folder, file) }] : [])
	: [];

export async function seedRaceAvatars(databasePath?: string, folder?: string) {
	const database = openInitializedDatabase({ path: databasePath });
	try {
		let loaded = 0;
		for (const { name, path } of raceAvatarFiles(folder)) {
			const { hash } = await uploadImage(database, await Bun.file(path).bytes());
			loaded += drizzle(database).insert(libraryDataTable).values({ namespace: boxReference("race"), key: `${RACE_AVATAR_PREFIX}${name}`, value: hash }).onConflictDoNothing().returning().all().length;
		}
		console.log(`[seed:race-avatars] loaded ${loaded} avatars from ${folder ?? RACE_AVATAR_FOLDER}/`);
	} finally {
		database.close();
	}
}

if (import.meta.main) await seedRaceAvatars(Bun.argv[2], Bun.argv[3]);
