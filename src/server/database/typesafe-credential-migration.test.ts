import { expect, test } from "bun:test";
import { join } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { openDatabase } from "./database";
import { writeEncryptedSecret } from "../connection-settings/persistence";
import { createTypesafeSettingsModule } from "../typesafe";

test.each([null, "saved-typesafe-secret"])("Typesafe credential migration preserves %s", (credential) => {
	const database = openDatabase({ path: ":memory:" });
	const masterKey = new Uint8Array(32).fill(19);
	const migrations = readMigrationFiles({ migrationsFolder: join(import.meta.dir, "migrations") });
	const moveCredential = migrations[10];
	if (moveCredential === undefined) throw new Error("Credential migration missing.");
	try {
		for (const migration of migrations.slice(0, 10)) for (const sql of migration.sql) database.exec(sql);
		database.query("INSERT INTO typesafe_settings (id, revision, jev_model, lore_trigger_threshold) VALUES (1, 7, 'jev-saved', 0.8)").run();
		if (credential !== null) {
			const secret = writeEncryptedSecret({ credential, headers: {} }, 1, masterKey);
			database.query("INSERT INTO typesafe_secret (id, format_version, key_id, nonce, ciphertext, tag) VALUES (1, ?, ?, ?, ?, ?)")
				.run(secret.format_version, secret.key_id, secret.nonce, secret.ciphertext, secret.tag);
		}
		for (const sql of moveCredential.sql) database.exec(sql);
		const typesafe = createTypesafeSettingsModule(database, { masterKey });
		expect(typesafe.get()).toMatchObject({ revision: 7, jevModel: "jev-saved", loreTriggerThreshold: 0.8, credentialConfigured: credential !== null });
		expect(typesafe.getCredential()).toBe(credential);
	} finally { database.close(); }
});
