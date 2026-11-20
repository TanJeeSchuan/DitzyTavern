import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";
import { noRawServerFetchRule } from "./no-raw-server-fetch.ts";

RuleTester.describe = describe;
RuleTester.it = it;
const server = "src/server/workflows/request.ts";

new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } }).run(
	"no-raw-server-fetch",
	noRawServerFetchRule,
	{
		valid: [
			{ filename: server, code: "function request(fetch: ModelFetch) { return fetch(url); }" },
			{ filename: server, code: "const { fetch } = options; fetch(url); options.fetch(url);" },
			{ filename: server, code: "type Fetch = typeof fetch;" },
			{ filename: server, code: "const options = { fetch() {} }; Bun.serve({ fetch(request) {} });" },
			{ filename: "src/client/request.ts", code: "fetch(url);" },
			{ filename: "src/server/application/shutdown.test.ts", code: "fetch(url);" },
			{ filename: "src/server/model-client/model-fetch.ts", code: "fetch(url);" },
			{ filename: "src/server/box/sandboxed-deps.ts", code: 'fetch(url, { redirect: "error" });' },
			{ filename: "src/server/authoring/provider.ts", code: "fetch(url, init);" },
		],
		invalid: [
			{ filename: server, code: "fetch(url);", errors: [{ messageId: "rawFetch" }] },
			{ filename: server, code: "globalThis.fetch(url);", errors: [{ messageId: "rawFetch" }] },
			{ filename: server, code: 'globalThis["fetch"]?.(url);', errors: [{ messageId: "rawFetch" }] },
			{ filename: server, code: "const send = fetch; send(url);", errors: [{ messageId: "rawFetch" }] },
		],
	},
);
