// Public contract of the generic Conversation artifact seam. Artifact
// metadata rows are committed atomically with their Conversation through the
// creation seam, while the exact bytes live outside SQLite in the managed
// artifact directory. Ordinary Conversation snapshots never contain artifact
// content; all access goes through these operations.

export type ArtifactUnavailableReason = "missing" | "corrupt";

// Derived, never stored: whether the physical copy currently satisfies the
// committed metadata. A missing or corrupt file is reported as cleaned up so
// provenance loss never makes the native Conversation look corrupt.
export type ArtifactAvailability =
	| { status: "available" }
	| { status: "cleaned-up"; reason: ArtifactUnavailableReason };

export interface ArtifactMetadata {
	chatId: number;
	namespace: string;
	key: string;
	// Path relative to the managed artifact directory of the deployment.
	relativePath: string;
	// The original leaf filename carried by the source, used verbatim for
	// presentation; response metadata is sanitized on download only.
	originalFilename: string;
	mediaType: string;
	byteLength: number;
	// Raw-byte SHA-256: the authoritative content digest of the exact stored
	// bytes, sensitive to BOM, line endings, whitespace, escape spelling,
	// blank lines, and trailing newline.
	sha256: string;
}

export interface ArtifactInspection extends ArtifactMetadata {
	availability: ArtifactAvailability;
}

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