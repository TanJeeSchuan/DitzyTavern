// @approved
//  Pure presentation state for the Chat information surface. Chat information
// is the ordinary way to inspect a Chat's details; Import Details appears
// inside it only when the Chat carries import provenance. There is no
// persistent Imported badge, header marker, or separate category.
// The reducer keeps the loading, no-provenance, unreadable, available, and
// error states testable without a browser: the view feeds typed transport
// outcomes in and derives the exact presentation (including cleaned-up
// artifact handling) from the state.

import type { ChatImportDetails } from "./chat-history";

export type ReadableChatImportDetails = Extract<
	ChatImportDetails,
	{ provenanceState: "readable" }
>;

export type ChatInformationState =
	// @approved
	// The panel opened; the lightweight Import Details check is in flight.
	| { status: "loading" }
	// @approved
	// The Chat exists but has no import provenance: generic Chat information
	//  only, with no imported marker of any kind.
	| { status: "no-import-details" }
	// @approved
	//  The Chat has an import report entry, but its persisted provenance cannot
	// be decoded. Keep this visible rather than treating it as never imported.
	| { status: "unreadable-import-details" }
	// @approved
	// Import Details loaded; the exact-artifact availability drives the
	//  download action and the cleaned-up presentation.
	| { status: "available"; details: ReadableChatImportDetails }
	// @approved
	// The details could not be loaded (transport failure); Chat information
	//  stays usable without importing specifics.
	| { status: "error" };

export type ChatInformationAction =
	| { type: "chat-opened" }
	| { type: "details-loaded"; details: ReadableChatImportDetails }
	| { type: "no-import-details" }
	| { type: "details-unreadable" }
	| { type: "details-failed" };

export const createChatInformationState = (): ChatInformationState => ({
	status: "loading",
});

export function reduceChatInformation(
	state: ChatInformationState,
	action: ChatInformationAction,
): ChatInformationState {
	switch (action.type) {
		case "chat-opened":
			return createChatInformationState();
		case "details-loaded":
			return { status: "available", details: action.details };
		case "no-import-details":
			return { status: "no-import-details" };
		case "details-unreadable":
			return { status: "unreadable-import-details" };
		case "details-failed":
			return { status: "error" };
	}
}

// @approved
// Derived download availability for the exact preserved source. Missing or
//  corrupt artifacts report cleaned up: only exact download is disabled while
// normal Chat reading and commands stay available.
export interface SourceDownloadAvailability {
	available: boolean;
	reason: "missing" | "corrupt" | null;
}

export const sourceDownloadAvailable = (
	state: ChatInformationState,
): SourceDownloadAvailability => {
	if (state.status !== "available" || state.details.artifact === null) {
		return { available: false, reason: null };
	}
	const availability = state.details.artifact.availability;
	if (availability.status === "available") {
		return { available: true, reason: null };
	}
	return { available: false, reason: availability.reason };
};

// @approved
// The exact-source presentation copy shown in Import Details: available, or
//  described as cleaned up with the typed reason. Provenance loss never makes
// the working Chat look corrupt.
export type ArtifactAvailabilityLabel = { status: "available" } | { status: "cleaned-up"; reason: "missing" | "corrupt" } | null;

export const artifactAvailabilityLabel = (
	state: ChatInformationState,
): ArtifactAvailabilityLabel => {
	if (state.status !== "available") return null;
	const artifact = state.details.artifact;
	if (artifact === null) return null;
	return artifact.availability;
};
