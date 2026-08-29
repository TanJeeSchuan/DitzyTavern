import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { noContractDefinitionOutsideContractRule } from "./no-contract-definition-outside-contract.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
	languageOptions: { parserOptions: { lang: "ts" } },
});

tester.run(
	"no-contract-definition-outside-contract",
	noContractDefinitionOutsideContractRule,
	{
		valid: [
			{
				filename: "src/shared/contract/generation-settings.ts",
				code: "export const GenerationSettingsSchema = Type.Object({ modelId: Type.String() });",
			},
			{
				filename: "src/client/generation-settings.ts",
				code: "type GenerationSettings = Static<typeof GenerationSettingsSchema>;",
			},
		],
		invalid: [
			{
				filename: "src/server/http/generation-settings.ts",
				code: "const GenerationSettingsSchema = Type.Object({ modelId: Type.String() });",
				errors: [{ messageId: "outsideOwner" }],
			},
			{
				filename: "src/client/transport/generation-settings.ts",
				code: "const response = t.Union([t.Object({ ok: t.Boolean() })]);",
				errors: [
					{ messageId: "outsideOwner" },
					{ messageId: "outsideOwner" },
				],
			},
		],
	},
);
