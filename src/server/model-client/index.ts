// @approved
//  Deep Model Client seam. Provider-neutral generation input and normalized
// events are public; concrete transports remain private to this module.

export {
	collectModelClientGeneration,
	ModelClientGenerationError,
} from "./client";
export { createFakeModelClient } from "./fake";
export { shouldSendImages } from "./types";
export {
	projectModelClientGenerationSettings,
} from "./generation-settings";
export type {
	ModelClient,
	ModelClientEvent,
	ModelClientFailureKind,
	ModelClientGenerationInput,
	ModelClientConnectionSnapshot,
	ModelClientUsage,
	ModelFetch,
} from "./types";
export {
	createModelClient,
	normalizeUsage,
	ModelClientTransportError,
} from "./chat-completions";
export {
	testConnection,
	TEST_CONNECTION_MAX_OUTPUT_TOKENS,
	TEST_CONNECTION_PROMPT,
} from "./test-connection";
export {
	discoverModels,
} from "./discovery";
export type {
	TestConnectionResult,
} from "./test-connection";

export { paintImage } from "./painting";
