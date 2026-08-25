import { staticPlugin } from "@elysiajs/static";
import { contract } from "../shared/contract";
import { openDatabase } from "./database/database";
import { initializeConnectionSecretKey } from "./connection-secrets";

initializeConnectionSecretKey();
const database = openDatabase();

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
	database.close();
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log(`DitzyTavern server listening on ${app.server?.url}`);
