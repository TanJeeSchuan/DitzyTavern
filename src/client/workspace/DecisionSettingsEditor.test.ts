import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { flushHook, renderHook } from "../test-fixtures/render-hook";
import type { DecisionSelection } from "../../shared/contract/decision-model";

const { useSettingsDraft } = await import("./DecisionSettingsEditor");

type Settings = DecisionSelection & { revision: number };
const settings = (revision: number, decisionModel: string): Settings => ({ revision, decisionProfileId: 1, decisionModel, decisionStateTokenLimit: 4_000 });

test("a save that lost to a change elsewhere does not overwrite it on the next save", async () => {
	let server = settings(1, "start");
	const sent: { decisionModel: string; expectedRevision: number }[] = [];
	const load = () => Promise.resolve(server);
	const apply = async ({ decisionModel, expectedRevision }: Omit<Settings, "revision"> & { expectedRevision: number }) => {
		sent.push({ decisionModel, expectedRevision });
		if (expectedRevision !== server.revision) return { outcome: "conflict" as const, reason: "stale-revision" as const, expectedRevision, actualRevision: server.revision, current: server };
		server = settings(server.revision + 1, decisionModel);
		return { outcome: "available" as const, value: { settings: server } };
	};
	const hook = await renderHook(() => useSettingsDraft<Settings>("Test Settings", load, apply), new QueryClient());
	await flushHook();
	await hook.act(async () => { hook.current.update({ decisionModel: "mine" }); });
	server = settings(2, "theirs");

	await hook.act(async () => { await hook.current.save(); });
	await hook.act(async () => { await hook.current.save(); });
	expect(sent).toEqual([{ decisionModel: "mine", expectedRevision: 1 }]);
	expect(server.decisionModel).toBe("theirs");
	expect(hook.current.draft?.decisionModel).toBe("mine");

	await hook.act(async () => { hook.current.keepMine(); });
	await hook.act(async () => { await hook.current.save(); });
	expect(sent.at(-1)).toEqual({ decisionModel: "mine", expectedRevision: 2 });
	expect(hook.current.dirty).toBe(false);
});

test("Load saved replaces a conflicted draft with the settings it lost to", async () => {
	let server = settings(1, "start");
	const load = () => Promise.resolve(server);
	const apply = async ({ expectedRevision }: { expectedRevision: number }) => ({ outcome: "conflict" as const, reason: "stale-revision" as const, expectedRevision, actualRevision: server.revision, current: server });
	const hook = await renderHook(() => useSettingsDraft<Settings>("Test Settings", load, apply), new QueryClient());
	await flushHook();
	await hook.act(async () => { hook.current.update({ decisionModel: "mine" }); });
	server = settings(2, "theirs");
	await hook.act(async () => { await hook.current.save(); });
	await hook.act(async () => { hook.current.discard(); });
	expect(hook.current.draft?.decisionModel).toBe("theirs");
	expect(hook.current.dirty).toBe(false);
});

test("the settings a summary reads follow a successful save", async () => {
	let server = settings(1, "start");
	const load = () => Promise.resolve(server);
	const apply = async ({ decisionModel, expectedRevision }: Omit<Settings, "revision"> & { expectedRevision: number }) => {
		server = settings(expectedRevision + 1, decisionModel);
		return { outcome: "available" as const, value: { settings: server } };
	};
	const hook = await renderHook(() => useSettingsDraft<Settings>("Test Settings", load, apply), new QueryClient());
	await flushHook();
	await hook.act(async () => { hook.current.update({ decisionModel: "mine" }); });
	await hook.act(async () => { await hook.current.save(); });
	expect(hook.current.settings).toEqual(settings(2, "mine"));
});

test("model settings use the shared committed query and update it after saving", async () => {
	let server = settings(1, "start");
	const client = new QueryClient();
	const key = ["model-selection", "image-model"] as const;
	const load = () => Promise.resolve(server);
	const apply = async ({ decisionModel, expectedRevision }: Omit<Settings, "revision"> & { expectedRevision: number }) => {
		server = settings(expectedRevision + 1, decisionModel);
		return { outcome: "available" as const, value: { settings: server } };
	};
	const hook = await renderHook(() => useSettingsDraft<Settings>("Image Model", load, apply, { key }), client);
	await flushHook();
	await hook.act(async () => { hook.current.update({ decisionModel: "draft" }); });
	expect(client.getQueryData<Settings>(key)).toEqual(settings(1, "start"));
	await hook.act(async () => { await hook.current.save(); });
	expect(client.getQueryData<Settings>(key)).toEqual(settings(2, "draft"));
});
