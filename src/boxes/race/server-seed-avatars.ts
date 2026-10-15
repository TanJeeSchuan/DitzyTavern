// @approved
//  Local roster avatars. Run with `bun run db:seed:race-avatars`.
// The repository ships no Runner art, so the images come from the gitignored
// `race-avatars/` folder, one file per roster Runner named after it, such as
// `race-avatars/Gold Ship.png`. A Runner that already has an avatar keeps it.

import { existsSync, readdirSync } from "node:fs";
import { join, parse } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { RACE_AVATAR_PREFIX, raceRoster } from "./shared-data";
import { openInitializedDatabase, putLibraryValue, readLibraryValues, uploadImage } from "@/box-sdk/server";

export const RACE_AVATAR_FOLDER = "race-avatars";

export const raceAvatarFiles = (folder = RACE_AVATAR_FOLDER) => existsSync(folder)
	? readdirSync(folder).flatMap((file) => raceRoster.some(({ name }) => name === parse(file).name) ? [{ name: parse(file).name, path: join(folder, file) }] : [])
	: [];

export async function seedRaceAvatars(databasePath?: string, folder?: string) {
	const database = openInitializedDatabase({ path: databasePath });
	try {
		const db = drizzle(database);
		const present = new Set(readLibraryValues(db, "race", RACE_AVATAR_PREFIX).map(({ key }) => key));
		const missing = raceAvatarFiles(folder).filter(({ name }) => !present.has(`${RACE_AVATAR_PREFIX}${name}`));
		for (const { name, path } of missing) {
			const { hash } = await uploadImage(database, await Bun.file(path).bytes());
			putLibraryValue(db, "race", { key: `${RACE_AVATAR_PREFIX}${name}`, value: hash }, () => {});
		}
		console.log(`[seed:race-avatars] loaded ${missing.length} avatars from ${folder ?? RACE_AVATAR_FOLDER}/`);
	} finally {
		database.close();
	}
}

if (import.meta.main) await seedRaceAvatars(Bun.argv[2], Bun.argv[3]);
