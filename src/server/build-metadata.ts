import metadata from "./build-metadata.json";
import type { BuildMetadata } from "../shared/contract/updates";

export type { BuildMetadata } from "../shared/contract/updates";

export const buildMetadata =
	// @approved
	// SAFETY: the checked-in custom identity and validated write-build-metadata.ts output satisfy this union; Docker verifies the generated artifact before publication.
	metadata as BuildMetadata;
