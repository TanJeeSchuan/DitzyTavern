import { Value } from "@sinclair/typebox/value";
import { api } from "./lib/eden";
import { NetworkError, SERVER_UNREACHABLE_NOTICE, foundOrNull, requestData } from "./lib/request-outcome";
import { requestOutcome } from "./lib/request-route-outcome";
import {
	lorebookReadResponse,
	lorebookCommandResponse,
	lorebookExportResponse,
	lorebookImportResponse,
	lorebookListResponse,
	loreMatchTestResponse,
	loreAttachmentStateResponse,
	lorebookAttachmentImpactResponse,
	lorebookOwnerAttachmentResponse,
	type LoreAttachmentState,
	type LorebookAttachmentImpact,
	type LorebookOwnerAttachmentState,
	nativeLorebook,
	type LoreMatchTestResponse,
	type LorebookCommand,
	type NativeLorebook,
	type Lorebook as LorebookValue,
	type LorebookListResponse,
} from "../shared/contract/lorebook";
import type { SillyTavernJsonValue } from "../shared/contract/prompt-preset";

export type { LorebookCommand, NativeLorebook, LorebookValue as Lorebook, LorebookListResponse, LoreAttachmentState };
export type { LorebookAttachmentImpact };
export type { LorebookOwnerAttachmentState };
export type LoreMatchTest = LoreMatchTestResponse;

export async function getLorebookAttachmentState(conversationId: number, signal?: AbortSignal): Promise<LoreAttachmentState | null> {
	return foundOrNull(await requestOutcome(
		api.api.lorebooks.attachments.get({ query: { conversationId }, fetch: { signal } }),
		loreAttachmentStateResponse,
	));
}

export async function getLorebookAttachmentImpact(bookId: number): Promise<LorebookAttachmentImpact | null> {
	return foundOrNull(await requestOutcome(api.api.lorebooks({ bookId }).attachments.get(), lorebookAttachmentImpactResponse));
}

export async function getCharacterLorebookAttachments(characterId: number, signal: AbortSignal): Promise<LorebookOwnerAttachmentState | null> {
	return foundOrNull(await requestOutcome(
		api.api.lorebooks.attachments.character.get({ query: { ownerId: characterId }, fetch: { signal } }),
		lorebookOwnerAttachmentResponse,
	));
}

export async function getParticipantLorebookAttachments(participantId: number, signal: AbortSignal): Promise<LorebookOwnerAttachmentState | null> {
	return foundOrNull(await requestOutcome(
		api.api.lorebooks.attachments.participant.get({ query: { ownerId: participantId }, fetch: { signal } }),
		lorebookOwnerAttachmentResponse,
	));
}

export async function listLorebooks(signal?: AbortSignal): Promise<LorebookListResponse["books"]> {
	return (await requestData(api.api.lorebooks.get({ fetch: { signal } }), lorebookListResponse[200])).books;
}

export async function getLorebook(bookId: number, signal?: AbortSignal): Promise<LorebookValue | null> {
	return foundOrNull(await requestOutcome(api.api.lorebooks({ bookId }).get({ fetch: { signal } }), lorebookReadResponse));
}

export async function testLorebookMatch(bookId: number, writing: string, signal?: AbortSignal): Promise<LoreMatchTest> {
	const outcome = await requestOutcome(
		api.api.lorebooks["match-test"].post({ bookId, writing }, { fetch: { signal } }),
		loreMatchTestResponse,
	);
	// @approved
	//  The missing-Lorebook race is the one domain condition a match test
	// declares: its notice stays verbatim, while an unreachable transport is
	// the retryable NetworkError and an unreadable response a plain Error.
	if (outcome.outcome === "not-found") throw new Error("That Lorebook no longer exists.");
	if (outcome.outcome === "network") throw new NetworkError(SERVER_UNREACHABLE_NOTICE);
	if (outcome.outcome === "unusable") throw new Error(outcome.reason);
	return outcome.value;
}

export type LorebookCommandResult = Awaited<ReturnType<typeof applyLorebookCommand>>;

export async function applyLorebookCommand(command: LorebookCommand) {
	return requestOutcome(api.api.lorebooks.commands.post(command), lorebookCommandResponse);
}

export function parseNativeLorebook(text: string): NativeLorebook | null {
	try {
		return Value.Parse(nativeLorebook, JSON.parse(text));
	} catch {
		return null;
	}
}

export async function importNativeLorebook(native: NativeLorebook) {
	return requestOutcome(api.api.lorebooks.import.post(native), lorebookImportResponse);
}

export async function importSillyTavernLorebook(source: SillyTavernJsonValue) {
	return requestOutcome(api.api.lorebooks.import.sillytavern.post({ source }), lorebookImportResponse);
}

export async function exportNativeLorebook(bookId: number): Promise<NativeLorebook> {
	return requestData(api.api.lorebooks({ bookId }).export.get(), lorebookExportResponse[200]);
}
