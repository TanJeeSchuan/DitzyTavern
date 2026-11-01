import { registerWireFormats } from "../shared/contract/wire-formats";
import { createApp } from "./app";
import { openInitializedDatabase } from "./database/database";
import { initializeConnectionSecretKey } from "./connection-secrets";
import { boxFolders, loadBoxes } from "./box/registry";

registerWireFormats();
const database = openInitializedDatabase();
initializeConnectionSecretKey({ secretsStored: database.query("SELECT 1 FROM connection_secret LIMIT 1").get() !== null });
await loadBoxes(boxFolders, database);
const { app, close } = await createApp({ database });
app.listen({ hostname: process.env.HOST ?? "127.0.0.1", port: Number(process.env.PORT ?? 3000) });

const shutdown = () => {
	process.off("SIGINT", shutdown);
	process.off("SIGTERM", shutdown);
	void close(async () => { await app.stop(); }).then(() => process.exit(0));
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log(`DitzyTavern server listening on ${app.server?.url}`);
