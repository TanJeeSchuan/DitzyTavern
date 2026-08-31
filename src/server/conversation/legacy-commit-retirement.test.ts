import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { collectTypeScriptSourceFiles } from "./source-files.test-support";

// The Generation architecture deepening retired the legacy terminal
// Generation and sibling commit entrances from the Conversation module.
// Acceptance and resolution seams own the lifecycle they duplicated. This
// repository-level check proves the retirement stays complete: no source
// file may reference either legacy command, its input type, or its
// implementation again, so a reintroduction fails here before it can ship.
const legacyEntranceNames = [
	"commitGeneration",
	"commitSiblingVariant",
	"commitConversationGeneration",
	"commitConversationSiblingVariant",
	"CommitGenerationInput",
	"CommitSiblingVariantInput",
];

test("no source file retains either legacy commit entrance", () => {
	const selfPath = join(import.meta.dir, "legacy-commit-retirement.test.ts");
	const offenders: string[] = [];
	for (const file of collectTypeScriptSourceFiles(join(import.meta.dir, "..", ".."))) {
		if (file === selfPath) continue;
		const content = readFileSync(file, "utf8");
		for (const name of legacyEntranceNames) {
			if (new RegExp(`\\b${name}\\b`).test(content)) {
				offenders.push(`${file}: ${name}`);
			}
		}
	}

	expect(offenders).toEqual([]);
});
