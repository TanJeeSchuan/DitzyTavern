// ==[HUMAN APPROVED]== Pure presentation state for the Chat information surface. Chat information
// is the ordinary way to inspect a Chat's details; Import Details appears
// inside it only when the Chat carries import provenance. There is no
// persistent Imported badge, header marker, or separate category.
//
// The reducer keeps the loading, no-provenance, available, and error states
// testable without a browser: the view feeds typed transport outcomes in and
// derives the exact presentation (including cleaned-up artifact handling)
// from the state.

import type { ChatImportDetails } from "./chat-history";

export type ChatInformationState =
	// The panel opened; the lightweight Import Details check is in flight.
	// ==[HUMAN APPROVED]==
	| { status: "loading" }
	// The Chat exists but has no import provenance: generic Chat information
	// ==[HUMAN APPROVED]== only, with no imported marker of any kind.
	| { status: "no-import-details" }
	// Import Details loaded; the exact-artifact availability drives the
	// ==[HUMAN APPROVED]== download action and the cleaned-up presentation.
	| { status: "available"; details: ChatImportDetails }
	// The details could not be loaded (transport failure); Chat information
	// ==[HUMAN APPROVED]== stays usable without importing specifics.
	| { status: "error" };

export type ChatInformationAction =
	| { type: "chat-opened" }
	| { type: "details-loaded"; details: ChatImportDetails }
	| { type: "no-import-details" }
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
		case "details-failed":
			return { status: "error" };
	}
}

// Derived download availability for the exact preserved source. Missing or
// ==[HUMAN APPROVED]== corrupt artifacts report cleaned up: only exact download is disabled while
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

// The exact-source presentation copy shown in Import Details: available, or
// ==[HUMAN APPROVED]== described as cleaned up with the typed reason. Provenance loss never makes
// the working Chat look corrupt.
export const artifactAvailabilityLabel = (
	state: ChatInformationState,
): { status: "available" } | { status: "cleaned-up"; reason: "missing" | "corrupt" } | null => {
	if (state.status !== "available") return null;
	const artifact = state.details.artifact;
	if (artifact === null) return null;
	return artifact.availability;
};