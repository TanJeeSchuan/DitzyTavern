import { initializeConnectionSecretKey } from "../connection-secrets";
import { expect, test } from "bun:test";
import { openInitializedDatabase } from "../database/database";
import { createConnectionSettingsModule } from "../connection-settings";
import { blankConnectionProfileDraft } from "../../shared/contract/connection-settings";
import { applyImageModelSettings, readImageModelSettings } from "./image-model-settings";

test("the app-wide Image Model selection rejects stale writes and non-Images connections", () => {
	initializeConnectionSecretKey({ environment: { CONNECTION_SECRET_KEY: Buffer.alloc(32, 1).toString("base64") } });
	using database = openInitializedDatabase({ path: ":memory:" });
	const connections = createConnectionSettingsModule(database, { masterKey: new Uint8Array(32).fill(1) });
	connections.createProfile({ expectedRevision: 0, profile: { ...blankConnectionProfileDraft, displayName: "Painter", apiFormat: "images" } });
	const profileId = connections.get().profiles[0]!.id;
	applyImageModelSettings(database, { type: "apply", expectedRevision: 0, profileId, model: "painter" });
	expect(readImageModelSettings(database)).toEqual({ revision: 1, profileId, model: "painter" });
	expect(() => applyImageModelSettings(database, { type: "apply", expectedRevision: 0, profileId: null, model: "" })).toThrow("revision");
	connections.applyProfile({ expectedRevision: 1, profileId, profile: { ...blankConnectionProfileDraft, displayName: "Writer" } });
	expect(() => applyImageModelSettings(database, { type: "apply", expectedRevision: 1, profileId, model: "writer" })).toThrow("Images connection");
});
