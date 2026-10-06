import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { ChatReply, JevRule, MemoryClaim, ModelCall } from "./protocol";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const buildClient = async () => {
	const build = spawn("bun", ["run", "build"], { cwd: ROOT, stdio: "inherit" });
	const [code] = await once(build, "exit");
	if (code !== 0) throw new Error(`Build exited ${code}`);
};

export type E2eServer = Awaited<ReturnType<typeof startE2eServer>>;

export const startE2eServer = async () => {
	let stderr = "";
	const launch = async (env: Record<string, string> = {}) => {
		const child = spawn("bun", ["e2e/server.ts"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
		child.stderr.on("data", (chunk) => stderr += chunk);
		const lines = createInterface({ input: child.stdout });
		const url = await new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("E2E server did not start within 30 seconds.")), 30_000);
			child.once("exit", (code) => reject(new Error(`E2E server exited ${code}\n${stderr}`)));
			lines.on("line", (line) => {
				if (!line.startsWith("E2E_READY ")) return;
				clearTimeout(timer);
				resolve(line.slice("E2E_READY ".length).replace(/\/$/, ""));
			});
		});
		return { child, url };
	};
	const first = await launch();
	const url = first.url;
	let child = first.child;
	process.once("exit", () => child.kill());
	const call = async (path: string, body?: ChatReply[] | JevRule[] | MemoryClaim[]) => (await fetch(`${url}/__e2e/${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body ?? {}),
	})).json();
	return {
		url,
		reset: () => call("reset"),
		chat: (...replies: ChatReply[]) => call("chat", replies),
		jev: (...rules: JevRule[]) => call("jev", rules),
		memories: (...claims: MemoryClaim[]) => call("memories", claims),
		release: () => call("release"),
		log: (): Promise<{ calls: ModelCall[]; unscripted: string[]; unsentPlans: string[] }> => call("log"),
		takeStderr: () => [stderr, stderr = ""][0],
		restart: async (signal: "SIGKILL" | "SIGHUP") => {
			const directory: string = await call("directory");
			child.kill(signal);
			await once(child, "exit");
			({ child } = await launch({ E2E_RESUME: directory, E2E_PORT: new URL(url).port }));
		},
		stop: async () => {
			child.kill("SIGTERM");
			await once(child, "exit");
		},
	};
};
