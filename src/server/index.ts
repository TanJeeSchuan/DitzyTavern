import { registerWireFormats } from "../shared/contract/wire-formats";
import { createApp } from "./app";
import { openInitializedDatabase } from "./database/database";
import { initializeConnectionSecretKey } from "./connection-secrets";

registerWireFormats();
initializeConnectionSecretKey();
const { app, close } = await createApp({ database: openInitializedDatabase() });
app.listen({ hostname: process.env.HOST ?? "127.0.0.1", port: 3000 });

const shutdown = () => {
	process.off("SIGINT", shutdown);
	process.off("SIGTERM", shutdown);
	void close(async () => { await app.stop(); }).then(() => process.exit(0));
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log(`DitzyTavern server listening on ${app.server?.url}`);
