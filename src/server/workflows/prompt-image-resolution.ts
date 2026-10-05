import type { Database } from "bun:sqlite";
import type { CanonicalGenerationSettings } from "../../shared/contract/generation-settings";
import { imageLookup } from "../image";
import { shouldSendImages, type ModelClientConnectionSnapshot } from "../model-client";
import type { PromptImageResolution } from "../prompt-compiler";

export const promptImageResolutionFor = (
	database: Database,
	connection: ModelClientConnectionSnapshot | null,
	settings: Pick<CanonicalGenerationSettings, "modelId" | "repeatedImagePlacement">,
): PromptImageResolution => ({
	lookup: imageLookup(database),
	placement: settings.repeatedImagePlacement,
	sendImages: shouldSendImages(connection, settings.modelId),
});
