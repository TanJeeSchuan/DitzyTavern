import { staticPlugin } from "@elysiajs/static";
import { contract } from "./contract";
import { openDatabase } from "./database/database";
import { initializeConnectionSecretKey } from "./connection-secrets";
import { gracefullyShutdownGenerations, recoverActiveGenerations } from "./workflows/generation-recovery";

initializeConnectionSecretKey();
const database = openDatabase();
// One process-start sweep resolves only abandoned local Active Generations;
// it never resumes or retries a provider request.
recoverActiveGenerations(database);

const serveIndex = () => Bun.file("dist/index.html");
const staticAssets = await staticPlugin({
	assets: "dist",
	prefix: "/",
	indexHTML: true,
	alwaysStatic: true,
});

const app = contract
	.get("/", serveIndex)
	.use(staticAssets)
	.onError(({ code, path }) => {
		if (
			code === "NOT_FOUND" &&
			!path.startsWith("/api/") &&
			!path.startsWith("/events")
		) {
			return serveIndex();
		}
	})
	.listen({ hostname: "127.0.0.1", port: 3000 });

const shutdown = () => {
	app.stop();
	gracefullyShutdownGenerations(database);
	database.close();
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log(`DitzyTavern server listening on ${app.server?.url}`);
