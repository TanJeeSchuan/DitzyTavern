import { describe, expect, test } from "bun:test";
import type { ChatImportDetails } from "./chat-history";
import {
	artifactAvailabilityLabel,
	createChatInformationState,
	reduceChatInformation,
	sourceDownloadAvailable,
} from "./chat-info";

// Focused client-state tests for the Chat information surface: Import
// Details loading, no-provenance Chat information, and cleaned-up artifact
// presentation. Pure reducer behavior only: transport outcomes feed in and
// presentation derives out.

const details = (
	overrides: Partial<Extract<ChatImportDetails, { provenanceState: "readable" }>> = {},
): Extract<ChatImportDetails, { provenanceState: "readable" }> => ({
	provenanceState: "readable",
	conversationId: 7,
	title: "Lantern House",
	receipt: {
		originalFilename: "lantern-house.jsonl",
		sha256: "abc123",
		byteLength: 464,
		integrity: null,
		counts: { messages: 2, variants: 2 },
		warnings: [],
		importerVersion: "0.2.0",
	},
	duplicates: { exact: [], related: [] },
	artifact: {
		chatId: 7,
		namespace: "import.sillytavern",
		key: "source.exact",
		relativePath: "uuid.jsonl",
		originalFilename: "lantern-house.jsonl",
		mediaType: "application/jsonl",
		byteLength: 464,
		sha256: "abc123",
		availability: { status: "available" },
	},
	...overrides,
});

describe("Chat information state", () => {
	test("loading then available exposes Import Details and enables the exact download", () => {
		const loading = reduceChatInformation(createChatInformationState(), {
			type: "chat-opened",
		});
		expect(loading.status).toBe("loading");
		expect(sourceDownloadAvailable(loading)).toEqual({
			available: false,
			reason: null,
		});

		const available = reduceChatInformation(loading, {
			type: "details-loaded",
			details: details(),
		});
		expect(available.status).toBe("available");
		expect(sourceDownloadAvailable(available)).toEqual({
			available: true,
			reason: null,
		});
		expect(artifactAvailabilityLabel(available)).toEqual({ status: "available" });
	});

	test("a Chat without import provenance shows no marker and no download", () => {
		const noProvenance = reduceChatInformation(createChatInformationState(), {
			type: "no-import-details",
		});
		expect(noProvenance.status).toBe("no-import-details");
		expect(sourceDownloadAvailable(noProvenance)).toEqual({
			available: false,
			reason: null,
		});
		expect(artifactAvailabilityLabel(noProvenance)).toBeNull();
	});

	test("an unreadable import report is visible and has no download", () => {
		const unreadable = reduceChatInformation(createChatInformationState(), {
			type: "details-unreadable",
		});
		expect(unreadable.status).toBe("unreadable-import-details");
		expect(sourceDownloadAvailable(unreadable)).toEqual({
			available: false,
			reason: null,
		});
		expect(artifactAvailabilityLabel(unreadable)).toBeNull();
	});

	test("missing and corrupt artifacts are presented as cleaned up and disable only exact download", () => {
		const missing = reduceChatInformation(createChatInformationState(), {
			type: "details-loaded",
			details: details({
				artifact: {
					chatId: 7,
					namespace: "import.sillytavern",
					key: "source.exact",
					relativePath: "uuid.jsonl",
					originalFilename: "lantern-house.jsonl",
					mediaType: "application/jsonl",
					byteLength: 464,
					sha256: "abc123",
					availability: { status: "cleaned-up", reason: "missing" },
				},
			}),
		});
		expect(sourceDownloadAvailable(missing)).toEqual({
			available: false,
			reason: "missing",
		});
		expect(artifactAvailabilityLabel(missing)).toEqual({
			status: "cleaned-up",
			reason: "missing",
		});

		const corrupt = reduceChatInformation(createChatInformationState(), {
			type: "details-loaded",
			details: details({
				artifact: {
					chatId: 7,
					namespace: "import.sillytavern",
					key: "source.exact",
					relativePath: "uuid.jsonl",
					originalFilename: "lantern-house.jsonl",
					mediaType: "application/jsonl",
					byteLength: 464,
					sha256: "abc123",
					availability: { status: "cleaned-up", reason: "corrupt" },
				},
			}),
		});
		expect(sourceDownloadAvailable(corrupt)).toEqual({
			available: false,
			reason: "corrupt",
		});
		expect(artifactAvailabilityLabel(corrupt)).toEqual({
			status: "cleaned-up",
			reason: "corrupt",
		});
	});

	test("transport failure keeps Chat information usable without import specifics", () => {
		const failed = reduceChatInformation(createChatInformationState(), {
			type: "details-failed",
		});
		expect(failed.status).toBe("error");
		expect(sourceDownloadAvailable(failed)).toEqual({
			available: false,
			reason: null,
		});
	});
});
