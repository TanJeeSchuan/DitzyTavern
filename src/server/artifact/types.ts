// Public contract of the generic Conversation artifact seam. Artifact
// metadata rows are committed atomically with their Conversation through the
// creation seam, while the exact bytes live outside SQLite in the managed
// artifact directory. Ordinary Conversation snapshots never contain artifact
// content; all access goes through these operations.
//
// The wire shape of an artifact inspection is owned by the shared Chat
// import contract (importDetailsArtifact); every exported representation
// here derives from it so the two can never drift.
import type {
	ImportCleanupReason,
	ImportDetailsArtifact,
	ImportDetailsArtifactAvailability,
} from "../../shared/contract/chat-import";

// The two ways an Exact Source Artifact copy can be missing content; missing
// or corrupt copies report cleaned up without affecting the Chat.
export type ArtifactUnavailableReason = ImportCleanupReason;

// Derived, never stored: whether the physical copy currently satisfies the
// committed metadata. A missing or corrupt file is reported as cleaned up so
// provenance loss never makes the native Conversation look corrupt.
export type ArtifactAvailability = ImportDetailsArtifactAvailability;

// The committed metadata of one stored artifact: the wire artifact shape
// without the derived availability.
export type ArtifactMetadata = Omit<ImportDetailsArtifact, "availability">;

// One stored artifact's committed metadata plus its derived availability.
export type ArtifactInspection = ImportDetailsArtifact;

// Reading the exact stored bytes. Absent or failing-verification files are a
// typed cleaned-up outcome, never an exception: the native Chat, canonical
// archive, and normal Conversation commands remain usable.
export type ArtifactReadResult =
	| {
			status: "available";
			artifact: ArtifactMetadata;
			bytes: Buffer;
	  }
	| {
			status: "cleaned-up";
			artifact: ArtifactMetadata;
			reason: ArtifactUnavailableReason;
	  };

// Download result: the exact stored bytes plus response metadata derived
// from the stored original leaf filename. Only the metadata is sanitized;
// the bytes are never altered.
export type ArtifactDownloadResult =
	| {
			status: "available";
			artifact: ArtifactMetadata;
			bytes: Buffer;
			contentDisposition: string;
	  }
	| {
			status: "cleaned-up";
			artifact: ArtifactMetadata;
			reason: ArtifactUnavailableReason;
	  };

export interface ArtifactModule {
	// Inspects one artifact by its (namespace, key) identity within the
	// Conversation, including derived availability. Undefined when the
	// Conversation owns no artifact with that identity.
	getArtifact(
		conversationId: number,
		namespace: string,
		key: string,
	): ArtifactInspection | undefined;
	// Streams the exact stored bytes after verification (byte length and
	// SHA-256), or reports the artifact as cleaned up.
	readArtifact(
		conversationId: number,
		namespace: string,
		key: string,
	): ArtifactReadResult | undefined;
	// Download variant: adds sanitized response metadata (Content-Disposition
	// built from the stored original leaf filename) without changing the
	// bytes.
	downloadArtifact(
		conversationId: number,
		namespace: string,
		key: string,
	): ArtifactDownloadResult | undefined;
}