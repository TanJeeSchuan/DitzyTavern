import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";
import { noUnguardedBoxHookRule } from "./no-unguarded-box-hook.ts";

RuleTester.describe = describe;
RuleTester.it = it;
const scenario = "src/server/authoring/scenario.ts";

new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } }).run(
	"no-unguarded-box-hook",
	noUnguardedBoxHookRule,
	{
		valid: [
			{ filename: scenario, code: "boxSetupRefusal(box, setup, previous);" },
			{ filename: scenario, code: "checked.box.advance?.run(input, ctx);" },
			{ filename: "src/server/box/setup.ts", code: "box.setupError?.(setup, previous);" },
			{ filename: "src/server/box/registry.ts", code: "box.moves.render(move, author);" },
			{ filename: "src/server/box/sandboxed.ts", code: "box.advance.run(input);" },
			{ filename: "src/server/workflows/generate.ts", code: "pipeline.run(); database.read(); if (box.setupError) handle(box); form.setupError(); host.status(); document.moves.render(); mailbox.box.status(); archiveBox.read();" },
		],
		invalid: [
			{ filename: scenario, code: "box.setupError?.(setup, previous);", errors: [{ messageId: "unguarded" }] },
			{ filename: "src/server/workflows/generate.ts", code: "loaded.box.advance?.run(input, ctx);", errors: [{ messageId: "unguarded" }] },
			{ filename: "src/server/workflows/generate.ts", code: 'box.records!.digest?.["run"](input, ctx);', errors: [{ messageId: "unguarded" }] },
			{ filename: "src/server/box/setup.ts", code: "box.status(setup, state);", errors: [{ messageId: "unguarded" }] },
		],
	},
);
