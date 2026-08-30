import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { noHandWrittenWireGuardsRule } from "./no-hand-written-wire-guards.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
	languageOptions: { parserOptions: { lang: "ts" } },
});

tester.run("no-hand-written-wire-guards", noHandWrittenWireGuardsRule, {
	valid: [
		{
			filename: "src/client/transport/settings-transport.ts",
			code: "const decode = (value: unknown) => Value.Check(SettingsSchema, value) ? value : null;",
		},
		{
			filename: "src/client/form-validation.ts",
			code: "const valid = isString(name) && isNumber(age) && isBoolean(active) && isRow(meta);",
		},
		{
			filename: "src/client/transport/settings-transport.ts",
			code: "const validateOptions = () => isString(name) && isNumber(age) && isBoolean(active) && isRow(meta);",
		},
		{
			// Non-transport client validation stays legitimate: the flow owns
			// no transport boundary contract.
			filename: "src/client/import-chat-flow.ts",
			code: `const parseDraft = (value: JsonValue) => {
				if (!isRow(value) || !isString(value.name)) return null;
				return value;
			};`,
		},
		{
			// Server application adapters may carry *Transport names without
			// becoming client wire-transport seams.
			filename: "src/server/application/generation-coordinator.ts",
			code: `interface ResolvedGenerationTransport { stop(): Promise<void>; }
			const parseSnapshot = (value: JsonValue) => {
				if (!isRow(value) || !isString(value.revision)) return null;
				return value;
			};`,
		},
	],
	invalid: [
		{
			filename: "src/client/transport/settings-transport.ts",
			code: `const parseSettings = (value: JsonValue) => {
				if (!isRow(value) || !isString(value.modelId)) return null;
				if (!isNumber(value.temperature)) return null;
				return value;
			};`,
			errors: [{ messageId: "handWrittenGuard" }],
		},
		{
			filename: "src/client/chat-history.ts",
			code: `interface ChatHistoryTransport { loadHistory(): Promise<unknown>; }
			const parseDownloadResponse = (value: JsonValue) => {
				if (isRow(value) && value.outcome === "cleaned-up") return value.reason;
				return null;
			};`,
			errors: [{ messageId: "handWrittenGuard" }],
		},
		{
			// A transport boundary is recognized by owning a *Transport
			// interface, with no transport-named path required.
			filename: "src/client/import-chat.ts",
			code: `interface ChatImportTransport { stage(bytes: Blob): Promise<unknown>; }
			const parsePreview = (value: JsonValue) => {
				if (!isRow(value) || !isString(value.sha256)) return null;
				return value;
			};`,
			errors: [{ messageId: "handWrittenGuard" }],
		},
	],
});
