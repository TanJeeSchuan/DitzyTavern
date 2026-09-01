// ==[HUMAN APPROVED]== Developer database command: import a SillyTavern JSONL chat export.
// Run with: bun run db:import <path-to-chat.jsonl>
//
// The Chat name comes from the source filename stem; the imported Chat has
// no Character memberships and starts at revision 0. Alongside the Chat, an
// independent exact-byte copy of the selected source is preserved under the
// managed artifact directory, whose metadata is committed with the Chat.

import { openDatabase } from "./database";
import { defaultArtifactDirectory } from "../artifact";
import { importSillyTavernChat } from "../sillytavern/import";
import { SillyTavernImportError } from "../sillytavern/errors";

const printUsage = () => {
	console.error("[import] usage: bun run db:import <path-to-chat.jsonl>");
};

const printSummary = (
	sourcePath: string,
): void => {
	const database = openDatabase();
	try {
		const { conversation, report, duplicateChatIds, artifact } =
			importSillyTavernChat(database, sourcePath, defaultArtifactDirectory());
		console.log(
			`[import] Created chat #${conversation.id} "${conversation.name}" from ${report.source.filename}`,
		);
		console.log(
			`[import] ${report.counts.messages} Messages, ${report.counts.variants} Variants, revision ${conversation.revision}`,
		);
		console.log(`[import] source sha256 ${report.source.sha256}`);
		console.log(
			`[import] exact source preserved (${artifact.byteLength} bytes) at ${artifact.relativePath} under the managed artifact directory`,
		);
		if (report.source.integrity !== undefined) {
			console.log(`[import] source integrity ${report.source.integrity}`);
		}
		if (report.warnings.length > 0) {
			console.log(
				`[import] Warnings (${report.warnings.length}):\n[import]   - ${report.warnings.join("\n[import]   - ")}`,
			);
		}
		if (duplicateChatIds.length > 0) {
			console.log(
				`[import] Duplicate of existing chat #${duplicateChatIds.join(", #")}; created as an independent copy`,
			);
		}
	} catch (error) {
		if (error instanceof SillyTavernImportError) {
			console.error(`[import] Import failed: ${error.message}`);
		} else {
			console.error(`[import] Unexpected failure: ${String(error)}`);
		}
		process.exitCode = 1;
	} finally {
		database.close();
	}
};

const isDirectRun = import.meta.main;
if (isDirectRun) {
	const sourcePath = process.argv[2];
	if (!sourcePath) {
		printUsage();
		process.exitCode = 1;
	} else {
		printSummary(sourcePath);
	}
}