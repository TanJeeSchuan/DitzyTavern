import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { ChatReply, DecisionRule, MemoryClaim, ModelCall, UpdateScenario } from "./protocol";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const buildClient = async () => {
	const build = spawn("bun", ["run", "build"], { cwd: ROOT, stdio: "inherit" });
	const [code] = await once(build, "exit");
	if (code !== 0) throw new Error(`Build exited ${code}`);
};

export type E2eServer = Awaited<ReturnType<typeof startE2eServer>>;

const stopChild = async (child: ChildProcess, signal: NodeJS.Signals) => {
	if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
	const exited = once(child, "exit");
	child.kill(signal);
	await exited;
};

export const startE2eServer = async () => {
	let stderr = "";
	const directory = mkdtempSync(join(tmpdir(), "ditzy-e2e-"));
	const launch = async (env: Record<string, string> = {}) => {
		const child = spawn("bun", ["e2e/server.ts"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, E2E_ROOT: directory, ...env } });
		const killOnExit = () => { child.kill("SIGKILL"); };
		const removeCleanup = () => { process.off("exit", killOnExit); };
		process.once("exit", killOnExit);
		child.once("exit", removeCleanup);
		child.once("error", removeCleanup);
		child.stderr.on("data", (chunk) => stderr += chunk);
		const lines = createInterface({ input: child.stdout });
		const ready = Promise.withResolvers<string>();
		const timer = setTimeout(() => ready.reject(new Error("E2E server did not start within 30 seconds.")), 30_000);
		const onExit = (code: number | null) => ready.reject(new Error(`E2E server exited ${code}\n${stderr}`));
		const onError = (error: Error) => ready.reject(error);
		child.once("exit", onExit);
		child.once("error", onError);
		lines.on("line", (line) => {
			if (line.startsWith("E2E_READY ")) ready.resolve(line.slice("E2E_READY ".length).replace(/\/$/, ""));
		});
		try {
			return { child, url: await ready.promise };
		} catch (error) {
			await stopChild(child, "SIGKILL");
			rmSync(directory, { recursive: true, force: true });
			throw error;
		} finally {
			clearTimeout(timer);
			lines.close();
			child.stdout.resume();
			child.off("exit", onExit);
			child.off("error", onError);
		}
	};
	const first = await launch();
	const url = first.url;
	let child = first.child;
	const call = async (path: string, body?: ChatReply[] | DecisionRule[] | MemoryClaim[] | string[][] | string[] | number | UpdateScenario) => (await fetch(`${url}/__e2e/${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body ?? {}),
	})).json();
	return {
		url,
		reset: () => call("reset"),
		chat: (...replies: ChatReply[]) => call("chat", replies),
		decisions: (...rules: DecisionRule[]) => call("decisions", rules),
		memories: (...claims: MemoryClaim[]) => call("memories", claims),
		models: (...catalogs: string[][]) => call("models", catalogs),
		embeddings: (...matches: string[]) => call("embeddings", matches),
		checkpointClock: (now: number) => call("checkpoint-clock", now),
		updates: (scenario: UpdateScenario) => call("updates", scenario),
		release: () => call("release"),
		log: (): Promise<{ calls: ModelCall[]; registryCalls: string[]; unscripted: string[]; unsentPlans: string[] }> => call("log"),
		takeStderr: () => [stderr, stderr = ""][0],
		restart: async (mode: "crash" | "graceful") => {
			const directory: string = await call("directory");
			if (mode === "crash") await stopChild(child, "SIGKILL");
			else {
				const exited = once(child, "exit");
				await call("shutdown");
				const [code] = await exited;
				if (code !== 0) throw new Error(`Graceful E2E shutdown exited ${code}\n${stderr}`);
			}
			({ child } = await launch({ E2E_RESUME: directory, E2E_PORT: new URL(url).port }));
		},
		stop: async () => {
			await stopChild(child, "SIGTERM");
			rmSync(directory, { recursive: true, force: true });
		},
	};
};
