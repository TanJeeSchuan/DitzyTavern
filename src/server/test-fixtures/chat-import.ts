import type { ChatImportModule } from "../sillytavern/staged";

export const stageImportBytes = (module: ChatImportModule, bytes: Uint8Array, originalFilename = "lantern-house.jsonl") =>
	module.stageFile({ bytes: new Blob([new Uint8Array(bytes)]).stream(), originalFilename });

export async function importChatFixture(module: ChatImportModule, source: string, filename?: string) {
	const { token, preview } = await stageImportBytes(module, Buffer.from(source, "utf8"), filename);
	return module.commit(token, {
		sha256: preview.sha256,
		title: preview.title,
		duplicateConfirmed: true,
		participants: preview.groups.map((group) => ({
			name: group.participantNameDefault,
			outcome: { type: "chat-only" },
			messagePositions: group.messagePositions,
		})),
	});
}
