import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { collectTypeScriptSourceFiles } from "./source-files.test-support";

// The Generation Coordinator is the only production entrance for operations
// that coordinate runtime state with durable Generation transitions, so the
// raw durable stop transitions are private implementation details of the
// Conversation module. This repository-level check proves the encapsulation
// stays complete: no server source file outside the Conversation module may
// reference either raw stop entrance, so a bypassing caller fails here before
// it can ship. (The client's same-named transport function is a different
// concept on the far side of the HTTP boundary and is intentionally out of
// scope.)
const rawStopEntrances = [
	"stopConversationGeneration",
	"stopConversationGenerations",
];

test("no server file outside the Conversation module retains a raw Generation stop entrance", () => {
	const selfPath = join(import.meta.dir, "stop-entrance-encapsulation.test.ts");
	const conversationModuleDirectory = join(import.meta.dir);
	const serverDirectory = join(import.meta.dir, "..");
	const offenders: string[] = [];
	for (const file of collectTypeScriptSourceFiles(serverDirectory)) {
		if (file.startsWith(conversationModuleDirectory)) continue;
		if (file === selfPath) continue;
		const content = readFileSync(file, "utf8");
		for (const name of rawStopEntrances) {
			if (new RegExp(`\\b${name}\\b`).test(content)) {
				offenders.push(`${file}: ${name}`);
			}
		}
	}

	expect(offenders).toEqual([]);
});
