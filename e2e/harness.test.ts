import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { startE2eServer } from "./harness.ts";
import { isChatModelCall } from "./protocol.ts";
import type { ConnectionSettingsCommandPayload, ConnectionTestDraftPayload } from "../src/shared/contract/connection-settings.ts";
import type { MemorySettingsCommand } from "../src/boxes/memory/contract.ts";
import type { BoxDecisionSettingsCommand } from "../src/shared/contract/box.ts";

const spawn = childProcess.spawn;

test("startup timeout kills and joins a child that never reports readiness", async (t) => {
	let child: ChildProcess;
	t.mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
		child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], args[2]);
		return child;
	});
	syncBuiltinESMExports();
	t.mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const started = startE2eServer();
		const rejected = assert.rejects(started, /did not start within 30 seconds/);
		await once(child!, "spawn");
		t.mock.timers.tick(30_000);
		await rejected;
		assert.equal(child!.signalCode, "SIGKILL");
	} finally {
		if (child!.exitCode === null && child!.signalCode === null) {
			const exited = once(child!, "exit");
			child!.kill("SIGKILL");
			await exited;
		}
		t.mock.restoreAll();
		syncBuiltinESMExports();
	}
});

test("the intercepted call log keeps provider request fields the interceptor does not declare", async () => {
	const server = await startE2eServer();
	const call = async (path: string, body?: ConnectionSettingsCommandPayload | ConnectionTestDraftPayload | MemorySettingsCommand | BoxDecisionSettingsCommand | { profileId: number } | Record<string, never>) => (await fetch(`${server.url}/api/${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	})).json();
	try {
		await server.reset();
		const { profiles } = await call("connection-settings");
		const chat = profiles.find((profile: { apiFormat: string }) => profile.apiFormat === "chat-completions");
		const { id, discoveryCatalog: _catalog, credentialConfigured: _credential, headers: _headers, textOnlyModels: _textOnly, ...draft } = chat;
		await call("connection-settings/test-connection", { profileId: id, profile: draft, modelId: "e2e-model" });
		const chatCall = (await server.log()).calls.find(isChatModelCall);
		assert.ok(chatCall, "the Test Connection logged a chat call");
		assert.match(JSON.stringify(chatCall.body), /"max_tokens"/, "the log keeps provider fields the call schema does not declare");
	} finally {
		await server.stop();
	}
});

test("stop resolves when the server has already crashed", async (t) => {
	let child: ChildProcess;
	t.mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
		child = spawn(...args);
		return child;
	});
	syncBuiltinESMExports();
	const server = await startE2eServer();
	const directory: string = await (await fetch(`${server.url}/__e2e/directory`, { method: "POST" })).json();
	try {
		const exited = once(child!, "exit");
		child!.kill("SIGKILL");
		await exited;
		await Promise.race([server.stop(), delay(500).then(() => { throw new Error("stop waited for an exit event that already happened"); })]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
		t.mock.restoreAll();
		syncBuiltinESMExports();
	}
});

test("unscripted discovery, embeddings and extraction are recorded as failures", async () => {
	const server = await startE2eServer();
	const call = async (path: string, body?: ConnectionSettingsCommandPayload | ConnectionTestDraftPayload | MemorySettingsCommand | BoxDecisionSettingsCommand | { profileId: number } | Record<string, never>) => (await fetch(`${server.url}/api/${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	})).json();
	try {
		await server.reset();
		const { profiles, revision: connectionRevision } = await call("connection-settings");
		const { presets } = await call("connection-settings/presets");
		const decisionPreset = presets.find((preset: { id: string }) => preset.id === "openrouter-decisions").profile;
		const created = await call("connection-settings/commands", { type: "create-profile", expectedRevision: connectionRevision, profile: decisionPreset });
		const decision = created.settings.profiles.find((profile: { apiFormat: string }) => profile.apiFormat === "system-one");
		const chat = profiles.find((profile: { apiFormat: string }) => profile.apiFormat === "chat-completions");
		const { id, discoveryCatalog: _catalog, credentialConfigured: _credential, headers: _headers, textOnlyModels: _textOnly, ...embedding } = profiles.find((profile: { apiFormat: string }) => profile.apiFormat === "embeddings");
		await call("connection-settings/discovery", { profileId: chat.id });
		await call("connection-settings/test-connection", { profileId: id, profile: embedding, modelId: "e2e-embedding" });
		const { revision, ...settings } = await call("boxes/memory/settings");
		await call("boxes/memory/settings/commands", {
			...settings, expectedRevision: revision,
			extractionProfileId: chat.id, extractionModel: "e2e-model", embeddingProfileId: id, embeddingModel: "e2e-embedding",
		});
		const { revision: decisionRevision } = await call("boxes/memory/decision-settings");
		await call("boxes/memory/decision-settings/commands", { type: "apply", expectedRevision: decisionRevision, decisionProfileId: decision.id, decisionModel: "e2e-decision", decisionStateTokenLimit: 16000 });
		const { activeChatId } = await call("workspace");
		await call(`conversations/${activeChatId}/boxes/memory/catch-up`, {});
		let log = await server.log();
		for (let attempt = 0; attempt < 100 && !log.calls.some(({ kind }) => kind === "extraction"); attempt++) {
			await delay(20);
			log = await server.log();
		}
		assert.deepEqual([...new Set(log.calls.map(({ kind }) => kind))].sort(), ["embeddings", "extraction", "models"]);
		assert.equal(log.unscripted.length, log.calls.length);
	} finally {
		await server.stop();
	}
});
