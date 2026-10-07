import metadata from "./build-metadata.json";

export type BuildMetadata =
	| { distribution: "custom"; buildNumber: null; revision: null }
	| { distribution: "official"; buildNumber: number; revision: string };

export const buildMetadata =
	// SAFETY: the checked-in custom identity and validated write-build-metadata.ts output satisfy this union; Docker verifies the generated artifact before publication.
	metadata as BuildMetadata;
