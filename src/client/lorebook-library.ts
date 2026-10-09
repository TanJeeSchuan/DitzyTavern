import type { StaticDecode } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { api } from "./lib/eden";
import { NetworkError, SERVER_UNREACHABLE_NOTICE, foundOrNull, requestData, requestOutcome, type RequestOutcome } from "./lib/request-outcome";
import {
	lorebook,
	lorebookCommandErrors,
	lorebookCommandResponse,
	lorebookImportApplied,
	lorebookListResponse,
	loreMatchTestResponse,
	loreAttachmentState,
	loreAttachmentCommandErrors,
	loreAttachmentCommandResponse,
	lorebookAttachmentImpact,
	lorebookOwnerAttachmentState,
	type LoreAttachmentState,
	type LoreAttachmentCommand,
	type LorebookAttachmentImpact,
	type LorebookOwnerAttachmentState,
	nativeLorebook,
	type LoreMatchTestResponse,
	type LorebookCommand,
	type NativeLorebook,
	type Lorebook as LorebookValue,
	type LorebookListResponse,
} from "../shared/contract/lorebook";
import { notFoundOutcome, readOutcomeErrors } from "../shared/contract/outcomes";
import type { SillyTavernJsonValue } from "../shared/contract/prompt-preset";

export type { LorebookCommand, NativeLorebook, LorebookValue as Lorebook, LorebookListResponse, LoreAttachmentState, LoreAttachmentCommand };
export type { LorebookAttachmentImpact };
export type { LorebookOwnerAttachmentState };
export type LoreMatchTest = LoreMatchTestResponse;

export async function getLorebookAttachmentState(conversationId: number, signal?: AbortSignal): Promise<LoreAttachmentState | null> {
	return foundOrNull(await requestOutcome(
		api.api.lorebooks.attachments.get({ query: { conversationId }, fetch: { signal } }),
		loreAttachmentState,
		notFoundOutcome,
	));
}

export async function applyLorebookAttachmentCommand(command: LoreAttachmentCommand) {
	return requestOutcome(
		api.api.lorebooks.attachments.commands.post(command),
		loreAttachmentCommandResponse,
		loreAttachmentCommandErrors,
	);
}

export async function getLorebookAttachmentImpact(bookId: number): Promise<LorebookAttachmentImpact | null> {
	return foundOrNull(await requestOutcome(api.api.lorebooks({ bookId }).attachments.get(), lorebookAttachmentImpact, notFoundOutcome));
}

export async function getCharacterLorebookAttachments(characterId: number): Promise<LorebookOwnerAttachmentState | null> {
	return foundOrNull(await requestOutcome(
		api.api.lorebooks.attachments.character.get({ query: { ownerId: characterId } }),
		lorebookOwnerAttachmentState,
		notFoundOutcome,
	));
}

export async function getParticipantLorebookAttachments(participantId: number): Promise<LorebookOwnerAttachmentState | null> {
	return foundOrNull(await requestOutcome(
		api.api.lorebooks.attachments.participant.get({ query: { ownerId: participantId } }),
		lorebookOwnerAttachmentState,
		notFoundOutcome,
	));
}

export async function listLorebooks(signal?: AbortSignal): Promise<LorebookListResponse["books"]> {
	return (await requestData(api.api.lorebooks.get({ fetch: { signal } }), lorebookListResponse)).books;
}

export async function getLorebook(bookId: number, signal?: AbortSignal): Promise<LorebookValue | null> {
	return foundOrNull(await requestOutcome(api.api.lorebooks({ bookId }).get({ fetch: { signal } }), lorebook, notFoundOutcome));
}

export async function testLorebookMatch(bookId: number, writing: string, signal?: AbortSignal): Promise<LoreMatchTest> {
	const outcome = await requestOutcome(
		api.api.lorebooks["match-test"].post({ bookId, writing }, { fetch: { signal } }),
		loreMatchTestResponse,
		notFoundOutcome,
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

export type LorebookCommandResult = RequestOutcome<StaticDecode<typeof lorebookCommandResponse>, StaticDecode<typeof lorebookCommandErrors>>;

export async function applyLorebookCommand(command: LorebookCommand): Promise<LorebookCommandResult> {
	return requestOutcome(
		api.api.lorebooks.commands.post(command),
		lorebookCommandResponse,
		lorebookCommandErrors,
	);
}

export function parseNativeLorebook(text: string): NativeLorebook | null {
	try {
		return Value.Parse(nativeLorebook, JSON.parse(text));
	} catch {
		return null;
	}
}

export async function importNativeLorebook(native: NativeLorebook) {
	return requestOutcome(
		api.api.lorebooks.import.post(native),
		lorebookImportApplied,
		readOutcomeErrors,
	);
}

export async function importSillyTavernLorebook(source: SillyTavernJsonValue) {
	return requestOutcome(
		api.api.lorebooks.import.sillytavern.post({ source }),
		lorebookImportApplied,
		readOutcomeErrors,
	);
}

export async function exportNativeLorebook(bookId: number): Promise<NativeLorebook> {
	return requestData(api.api.lorebooks({ bookId }).export.get(), nativeLorebook);
}
