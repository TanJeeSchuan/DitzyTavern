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
	],
	invalid: [
		{
			filename: "src/client/transport/settings-transport.ts",
			code: `const parseSettings = (value: JsonValue) => {
				if (!isRow(value) || !isString(value.modelId)) return null;
				if (!isNumber(value.temperature) || !Array.isArray(value.stops)) return null;
				return value;
			};`,
			errors: [{ messageId: "handWrittenGuard" }],
		},
	],
});
