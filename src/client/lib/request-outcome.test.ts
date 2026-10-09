import { afterEach, describe, expect, test } from "bun:test";
import { macroVariables } from "../../shared/contract/macro-variables";
import { readOutcomeErrors } from "../../shared/contract/outcomes";
import type { WirePayload } from "./wire-decode";

const originalFetch = globalThis.fetch;
Object.defineProperty(globalThis, "window", {
	configurable: true,
	// SAFETY: the test supplies the minimal browser location read by Eden.
	value: { location: { origin: "http://localhost" } } as Window,
});
const { api } = await import("./eden");
const { NetworkError, SERVER_UNREACHABLE_NOTICE, SERVER_UNUSABLE_RESPONSE_NOTICE, requestOutcome, requestData } = await import("./request-outcome");

// The macro-variables read is a stand-in route: its 200 payload is an object
// schema and its modeled errors are the shared not-found/invalid envelopes.
const macroVariablesRequest = () =>
	api.api.conversations({ id: 3 })["macro-variables"].get({ query: {} });

const json = (body: WirePayload, status: number): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("requestOutcome", () => {
	test("a 200 payload that satisfies the contract is available with its decoded value", async () => {
		installFetch(async () => json({
			conversationId: 3,
			promptPresetId: 5,
			promptPresetName: "Default",
			position: 0,
			target: { type: "initial" },
			variables: [],
		}, 200));
		expect(await requestOutcome(macroVariablesRequest(), macroVariables, readOutcomeErrors)).toEqual({
			outcome: "available",
			value: {
				conversationId: 3,
				promptPresetId: 5,
				promptPresetName: "Default",
				position: 0,
				target: { type: "initial" },
				variables: [],
			},
		});
	});

	test("a modeled error body passes through verbatim", async () => {
		installFetch(async () => json({ outcome: "not-found" }, 404));
		expect(await requestOutcome(macroVariablesRequest(), macroVariables, readOutcomeErrors)).toEqual({ outcome: "not-found" });
	});

	test("an error body with an unmodeled outcome tag is the shared invalid fallback, never network", async () => {
		installFetch(async () => json({ outcome: "conflict" }, 409));
		expect(await requestOutcome(macroVariablesRequest(), macroVariables, readOutcomeErrors)).toEqual({
			outcome: "invalid",
			reason: SERVER_UNUSABLE_RESPONSE_NOTICE,
		});
	});

	test("a modeled tag with missing required fields is the shared invalid fallback", async () => {
		installFetch(async () => json({ outcome: "invalid" }, 422));
		expect(await requestOutcome(macroVariablesRequest(), macroVariables, readOutcomeErrors)).toEqual({
			outcome: "invalid",
			reason: SERVER_UNUSABLE_RESPONSE_NOTICE,
		});
	});

	test("an error body without the wire outcome tag is the shared invalid fallback", async () => {
		installFetch(async () => json({ type: "validation", on: "body" }, 422));
		expect(await requestOutcome(macroVariablesRequest(), macroVariables, readOutcomeErrors)).toEqual({
			outcome: "invalid",
			reason: SERVER_UNUSABLE_RESPONSE_NOTICE,
		});
	});

	test("a 200 body that fails the contract is the shared invalid fallback", async () => {
		installFetch(async () => json({ unexpected: true }, 200));
		expect(await requestOutcome(macroVariablesRequest(), macroVariables, readOutcomeErrors)).toEqual({
			outcome: "invalid",
			reason: SERVER_UNUSABLE_RESPONSE_NOTICE,
		});
	});

	test("a body Eden cannot parse is the shared invalid fallback, not a transport failure", async () => {
		installFetch(async () => new Response("{", { headers: { "content-type": "application/json" } }));
		expect(await requestOutcome(macroVariablesRequest(), macroVariables, readOutcomeErrors)).toEqual({
			outcome: "invalid",
			reason: SERVER_UNUSABLE_RESPONSE_NOTICE,
		});
	});

	test("a rejected request is network", async () => {
		installFetch(async () => {
			throw new TypeError("fetch failed");
		});
		expect(await requestOutcome(macroVariablesRequest(), macroVariables, readOutcomeErrors)).toEqual({ outcome: "network" });
	});

	test("a modeled invalid envelope passes through with its reason", async () => {
		installFetch(async () => json({ outcome: "invalid", reason: "Nope" }, 422));
		expect(await requestOutcome(macroVariablesRequest(), macroVariables, readOutcomeErrors)).toEqual({
			outcome: "invalid",
			reason: "Nope",
		});
	});
});

describe("requestData", () => {
	test("a 200 payload that satisfies the contract is the decoded value", async () => {
		installFetch(async () => json({
			conversationId: 3,
			promptPresetId: 5,
			promptPresetName: "Default",
			position: 0,
			target: { type: "initial" },
			variables: [],
		}, 200));
		expect(await requestData(macroVariablesRequest(), macroVariables)).toEqual({
			conversationId: 3,
			promptPresetId: 5,
			promptPresetName: "Default",
			position: 0,
			target: { type: "initial" },
			variables: [],
		});
	});

	test("a rejected request is the retryable NetworkError with the unreachable notice", async () => {
		installFetch(async () => { throw new TypeError("fetch failed"); });
		await expect(requestData(macroVariablesRequest(), macroVariables)).rejects.toThrow(SERVER_UNREACHABLE_NOTICE);
		await expect(requestData(macroVariablesRequest(), macroVariables)).rejects.toBeInstanceOf(NetworkError);
	});

	test("an error status and an unreadable body are a plain Error, never the retryable NetworkError", async () => {
		for (const response of [
			async () => json({ outcome: "not-found" }, 404),
			async () => json({ unexpected: true }, 200),
			async () => new Response("{", { headers: { "content-type": "application/json" } }),
		]) {
			installFetch(response);
			await expect(requestData(macroVariablesRequest(), macroVariables)).rejects.toThrow(SERVER_UNUSABLE_RESPONSE_NOTICE);
			await expect(requestData(macroVariablesRequest(), macroVariables)).rejects.not.toBeInstanceOf(NetworkError);
		}
	});
});

function installFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): void {
	globalThis.fetch = Object.assign(handler, { preconnect: () => {} });
}
