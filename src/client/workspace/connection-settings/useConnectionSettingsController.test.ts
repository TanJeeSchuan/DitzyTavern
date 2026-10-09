import { afterEach, expect, test } from "bun:test";
import { flushHook, renderHook } from "../../test-fixtures/render-hook";
import { QueryClient } from "@tanstack/react-query";
import { blankConnectionProfileDraft } from "../../../shared/contract/connection-settings";
import type { ConnectionProfile, ConnectionSettings } from "../../connection-settings";

const { useConnectionSettingsController } = await import("./useConnectionSettingsController");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const key = ["connection-settings", "settings"];
const profile = (name: string): ConnectionProfile => ({
	...blankConnectionProfileDraft, id: 1, displayName: name, requestUrl: "https://provider.example/v1",
	credentialConfigured: true, discoveryCatalog: [], textOnlyModels: [], headers: [],
});
const settings = (revision: number, name: string): ConnectionSettings => ({ revision, profiles: [profile(name)] });
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
const installFetch = (handler: (url: string, init?: RequestInit) => Promise<Response>) => {
	globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init), { preconnect() {} });
};

test("a late settings read cannot roll back a successful save", async () => {
	const cache = client();
	cache.setQueryData(key, settings(2, "Original"));
	const lateRead = Promise.withResolvers<Response>();
	let reads = 0;
	let expectedRevision: unknown;
	installFetch(async (url, init) => {
		if (url.endsWith("/presets")) return Response.json({ presets: [] });
		if (url.endsWith("/commands")) {
			expectedRevision = JSON.parse(String(init?.body)).expectedRevision;
			return Response.json({ outcome: "applied", settings: settings(3, "Saved") });
		}
		reads++;
		return lateRead.promise;
	});
	const editor = await renderHook(useConnectionSettingsController, cache);
	await editor.act(async () => { void cache.refetchQueries({ queryKey: key }, { cancelRefetch: false }); });
	await editor.act(async () => editor.current.chooseProfile(profile("Original")));
	await editor.act(async () => { await editor.current.applyDraft(); });
	await flushHook();
	expect(editor.current.settings?.revision).toBe(3);
	await editor.act(async () => { lateRead.resolve(Response.json(settings(2, "Original"))); });
	await flushHook();
	expect(editor.current.settings?.revision).toBe(3);
	expect(editor.current.settings?.profiles[0]?.displayName).toBe("Saved");
	expect(expectedRevision).toBe(2);
	expect(reads).toBe(1);
});

const { useConnectionSettingsQuery, publishConnectionSettings } = await import("../../connection-settings-query");
const connectionsReader = () => {
	const { data, refetch } = useConnectionSettingsQuery();
	return { data, refetch };
};

test("a conflict adopts authority for every reader while retaining the edited Profile", async () => {
	const cache = client();
	cache.setQueryData(key, settings(2, "Original"));
	let submitted: unknown;
	installFetch(async (url, init) => {
		if (url.endsWith("/presets")) return Response.json({ presets: [] });
		submitted = JSON.parse(String(init?.body));
		return Response.json({ outcome: "conflict", expectedRevision: 2, actualRevision: 4, currentSettings: settings(4, "Authority") }, { status: 409 });
	});
	const editor = await renderHook(useConnectionSettingsController, cache);
	const reader = await renderHook(connectionsReader, cache);
	await editor.act(async () => editor.current.chooseProfile(profile("Original")));
	await editor.act(async () => {
		editor.current.setDraft({ ...editor.current.draft, displayName: "Local" });
		editor.current.setCredentialDraft("secret");
	});
	await editor.act(async () => { expect(await editor.current.applyDraft()).toBe(false); });
	await flushHook();
	expect(submitted).toMatchObject({ expectedRevision: 2, profile: { displayName: "Local" }, credential: "secret" });
	expect(editor.current.settings).toEqual(settings(4, "Authority"));
	expect(reader.current.data).toEqual(settings(4, "Authority"));
	expect(editor.current.draft.displayName).toBe("Local");
	expect(editor.current.credentialDraft).toBe("secret");
	expect(editor.current.conflict?.actualRevision).toBe(4);
});

test("deletion adopts authority for every reader and clears pending deletion", async () => {
	const cache = client();
	cache.setQueryData(key, settings(2, "Original"));
	const deleted = { revision: 3, profiles: [] };
	let submitted: unknown;
	installFetch(async (url, init) => {
		if (url.endsWith("/presets")) return Response.json({ presets: [] });
		submitted = JSON.parse(String(init?.body));
		return Response.json({ outcome: "applied", settings: deleted });
	});
	const editor = await renderHook(useConnectionSettingsController, cache);
	const reader = await renderHook(connectionsReader, cache);
	await editor.act(async () => editor.current.requestProfileDeletion(profile("Original")));
	await editor.act(async () => { await editor.current.deletePendingProfile(); });
	await flushHook();
	expect(submitted).toEqual({ type: "delete-profile", expectedRevision: 2, profileId: 1 });
	expect(editor.current.settings).toEqual(deleted);
	expect(reader.current.data).toEqual(deleted);
	expect(editor.current.pendingDeletionProfileId).toBeNull();
	expect(editor.current.notice).toBe("Original deleted.");
});

test("saving A then editing B and restoring A preserves the credential draft and feedback", async () => {
	const cache = client();
	cache.setQueryData(key, settings(2, "Original"));
	const response = Promise.withResolvers<Response>();
	installFetch(async (url) => url.endsWith("/presets") ? Response.json({ presets: [] }) : response.promise);
	const editor = await renderHook(useConnectionSettingsController, cache);
	await editor.act(async () => editor.current.chooseProfile(profile("Original")));
	await editor.act(async () => editor.current.setCredentialDraft("secret"));
	const draft = editor.current.draft;
	let saving: Promise<boolean> | undefined;
	await editor.act(async () => { saving = editor.current.applyDraft(); });
	await editor.act(async () => editor.current.setDraft({ ...draft, displayName: "B" }));
	await editor.act(async () => editor.current.setDraft(draft));
	await editor.act(async () => { response.resolve(Response.json({ outcome: "applied", settings: settings(3, "Normalized") })); await saving; });
	await flushHook();
	expect(editor.current.settings).toEqual(settings(3, "Normalized"));
	expect(editor.current.draft.displayName).toBe("Original");
	expect(editor.current.credentialDraft).toBe("secret");
	expect(editor.current.notice).toBeNull();
});

test("StrictMode mount and repeated readers share one settings request and all see writes", async () => {
	const cache = client();
	let reads = 0;
	const response = Promise.withResolvers<Response>();
	installFetch(async () => { reads++; return response.promise; });
	const first = await renderHook(connectionsReader, cache, true);
	const others = [];
	for (let i = 0; i < 20; i++) others.push(await renderHook(connectionsReader, cache));
	await first.rerender();
	await first.rerender();
	await first.act(async () => response.resolve(Response.json(settings(2, "Original"))));
	await flushHook();
	expect(reads).toBe(1);
	await first.act(async () => { publishConnectionSettings(cache, settings(3, "Pinned")); });
	await flushHook();
	expect(first.current.data).toEqual(settings(3, "Pinned"));
	for (const reader of others) expect(reader.current.data).toEqual(settings(3, "Pinned"));
	const lateReader = await renderHook(connectionsReader, cache);
	expect(lateReader.current.data).toEqual(settings(3, "Pinned"));
	expect(reads).toBe(1);
});

test("a settings request aborts when its last reader unmounts", async () => {
	const cache = client();
	const response = Promise.withResolvers<Response>();
	let signal: AbortSignal | null | undefined;
	installFetch(async (_url, init) => { signal = init?.signal; return response.promise; });
	const reader = await renderHook(connectionsReader, cache);
	await reader.unmount();
	expect(signal?.aborted).toBe(true);
	await reader.act(async () => response.resolve(Response.json(settings(2, "Late"))));
	await flushHook();
	expect(cache.getQueryData(key)).toBeUndefined();
});

test("a late read cannot undo a text-only write at the same revision", async () => {
	const cache = client();
	cache.setQueryData(key, settings(2, "Original"));
	const response = Promise.withResolvers<Response>();
	let signal: AbortSignal | null | undefined;
	installFetch(async (_url, init) => { signal = init?.signal; return response.promise; });
	const reader = await renderHook(connectionsReader, cache);
	await reader.act(async () => { void reader.current.refetch(); });
	const marked: ConnectionSettings = { revision: 2, profiles: [{ ...profile("Original"), textOnlyModels: ["model"] }] };
	await reader.act(async () => { publishConnectionSettings(cache, marked); });
	await reader.act(async () => response.resolve(Response.json(settings(2, "Original"))));
	await flushHook();
	expect(signal?.aborted).toBe(true);
	expect(reader.current.data?.profiles[0]?.textOnlyModels).toEqual(["model"]);
});

test("StrictMode and rerenders issue one settings read and one presets read", async () => {
	const cache = client();
	const reads: string[] = [];
	installFetch(async (url) => {
		reads.push(url.endsWith("/presets") ? "presets" : "settings");
		return Response.json(url.endsWith("/presets") ? { presets: [] } : settings(2, "Original"));
	});
	const editor = await renderHook(useConnectionSettingsController, cache, true);
	await editor.rerender();
	await editor.rerender();
	await flushHook();
	expect(reads.sort()).toEqual(["presets", "settings"]);
});
