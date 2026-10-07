import { buildMetadata, type BuildMetadata } from "./build-metadata";
import type { UpdateStatus } from "../shared/contract/updates";
import { Value } from "@sinclair/typebox/value";
import { registryPullToken, publishedBuildIndex } from "../shared/contract/update-registry";

export type RegistryFetch = (input: string, init?: RequestInit) => Promise<Response>;
export interface UpdateCheckerOptions { build?: BuildMetadata; registryFetch?: RegistryFetch }

async function publishedBuild(registryFetch: RegistryFetch, stopping: AbortSignal) {
	const signal = AbortSignal.any([stopping, AbortSignal.timeout(15_000)]);
	const tokenResponse = await registryFetch("https://ghcr.io/token?service=ghcr.io&scope=repository:tanjeeschuan/ditzytavern:pull", { signal });
	if (!tokenResponse.ok) throw new Error(`Registry authentication failed (${tokenResponse.status}).`);
	const tokenBody: unknown = await tokenResponse.json();
	if (!Value.Check(registryPullToken, tokenBody)) throw new Error("Registry did not return an anonymous pull token.");
	const { token } = tokenBody;
	const response = await registryFetch("https://ghcr.io/v2/tanjeeschuan/ditzytavern/manifests/latest", { signal, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json" } });
	if (!response.ok) throw new Error(`Registry lookup failed (${response.status}).`);
	const index: unknown = await response.json();
	if (!Value.Check(publishedBuildIndex, index)) throw new Error("Published index has invalid official build metadata.");
	const annotations = index.annotations;
	const number = annotations["io.ditzytavern.build-number"];
	const revision = annotations["org.opencontainers.image.revision"];
	if (!Number.isSafeInteger(Number(number))) throw new Error("Published index has invalid official build metadata.");
	return { buildNumber: Number(number), revision };
}

export function createUpdateChecker({ build = buildMetadata, registryFetch = fetch }: UpdateCheckerOptions = {}) {
	let state: UpdateStatus = { build, result: null, attempt: null };
	let inFlight: Promise<UpdateStatus> | undefined;
	const stopping = new AbortController();
	const listeners = new Map<(state: UpdateStatus) => void, (() => void) | undefined>();
	const publish = () => { for (const listener of listeners.keys()) listener(state); };
	const check = (): Promise<UpdateStatus> => {
		if (build.distribution === "custom" || stopping.signal.aborted) return Promise.resolve(state);
		if (inFlight) return inFlight;
		state = { ...state, attempt: { status: "checking", startedAt: new Date().toISOString(), error: null } };
		inFlight = (async () => {
			try {
				const available = await publishedBuild(registryFetch, stopping.signal);
				state = { ...state, result: { ...available, comparison: available.buildNumber > build.buildNumber ? "update_available" : available.buildNumber === build.buildNumber ? "current" : "ahead", checkedAt: new Date().toISOString() }, attempt: { ...state.attempt!, status: "succeeded", error: null } };
			} catch (error) {
				state = { ...state, attempt: { ...state.attempt!, status: "failed", error: error instanceof Error ? error.message : "Update check failed." } };
			} finally { inFlight = undefined; publish(); }
			return state;
		})();
		publish();
		return inFlight;
	};
	return {
		get: () => state,
		check,
		subscribe: (listener: (state: UpdateStatus) => void, onClose?: () => void) => {
			if (stopping.signal.aborted) { onClose?.(); return () => {}; }
			listeners.set(listener, onClose); listener(state);
			return () => { listeners.delete(listener); };
		},
		stop: async () => {
			stopping.abort(new Error("Update checker stopped."));
			for (const close of listeners.values()) close?.();
			listeners.clear();
			await inFlight;
		},
	};
}
export type UpdateChecker = ReturnType<typeof createUpdateChecker>;
