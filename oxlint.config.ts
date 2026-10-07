import { defineConfig } from "oxlint";

export default defineConfig({
	ignorePatterns: [
		".agent/**",
		".agents/**",
		".claude/**",
		".codex/**",
		".continue/**",
		".cursor/**",
		".gemini/**",
		".opencode/**",
		".pi/**",
		".roo/**",
		".windsurf/**",
		"tools/oxlint/anti-slop/**",
		"tools/oxlint/ditzy/**",
	],
	jsPlugins: [
		{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
		{ name: "ditzy", specifier: "./tools/oxlint/ditzy/index.ts" },
	],
	rules: {
		"anti-slop/no-chained-type-assertions": "error",
		"anti-slop/no-conditional-empty-object-spread": "error",
		"anti-slop/no-known-value-widening": "error",
		"anti-slop/no-module-mocking": "error",
		"anti-slop/no-object-parameters": "error",
		"anti-slop/no-reflect-apply": "error",
		"anti-slop/no-reflect-get": "error",
		"anti-slop/no-runtime-typeof": "error",
		"anti-slop/no-shape-in-symbol-names": "error",
		"anti-slop/no-unknown-parameters": "error",
		"anti-slop/no-unknown-returns": "error",
		"anti-slop/no-unknown-type-aliases": "error",
		"anti-slop/no-unsafe-dictionary-type": "error",
		"anti-slop/no-unapproved-comments": [
			"warn",
			{
				// ==[HUMAN APPROVED]== Repo policy: opt out file classes where comments are the deliverable.
				ignoreFilePatterns: [
					"\\.(test|spec)\\.[cm]?[jt]sx?$", // test files ==[HUMAN APPROVED]==
					"^src/shared/contract/", // wire contract modules ==[HUMAN APPROVED]==
					"(^|/)types\\.ts$", // type-definition modules ==[HUMAN APPROVED]==
					"^scripts/", // tooling scripts ==[HUMAN APPROVED]==
				],
			},
		],
		"anti-slop/no-overlong-code-lines": "warn",
		"anti-slop/no-widen-then-assert": "error",
		"anti-slop/require-safety-comment-for-type-assertion": "error",
		"ditzy/no-contract-definition-outside-contract": "error",
		"ditzy/no-hand-written-wire-guards": "error",
		"ditzy/no-layer-dependencies-in-shared": "error",
		"ditzy/no-manual-conversation-transaction": "error",
		"ditzy/no-server-runtime-imports-in-client": "error",
	},
});
