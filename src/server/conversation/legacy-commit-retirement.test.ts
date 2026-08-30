import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

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

const collectSourceFiles = (directory: string, files: string[] = []): string[] => {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const fullPath = join(directory, entry.name);
		if (entry.isDirectory()) {
			collectSourceFiles(fullPath, files);
		} else if (/\.(ts|tsx)$/.test(entry.name)) {
			files.push(fullPath);
		}
	}
	return files;
};

test("no source file retains either legacy commit entrance", () => {
	const selfPath = join(import.meta.dir, "legacy-commit-retirement.test.ts");
	const offenders: string[] = [];
	for (const file of collectSourceFiles(join(import.meta.dir, "..", ".."))) {
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
