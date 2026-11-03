// @approved
//  `bun run dev:server`: the server under `bun --watch`, restarted as well when
// a file under `src/boxes` changes, which `--watch` misses for a built-in
// sandboxed Box, since the registry bundles its `logic.ts` and `ui.ts` at
// startup instead of importing them. The server ending on its own, as
// `dev:stop` ends it, ends this script too.
import { watch } from "node:fs";

const start = () => Bun.spawn(["bun", "--watch", "src/server/index.ts"], { stdio: ["inherit", "inherit", "inherit"] });
let server = start();
let restarting = false;
const follow = () => void server.exited.then((code) => { if (!restarting) process.exit(code); });
follow();
let pending: ReturnType<typeof setTimeout> | undefined;
watch("src/boxes", { recursive: true }, () => {
	clearTimeout(pending);
	pending = setTimeout(async () => {
		restarting = true;
		server.kill();
		await server.exited;
		server = start();
		restarting = false;
		follow();
	}, 100);
});
