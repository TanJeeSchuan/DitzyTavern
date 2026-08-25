// Deep Model Client seam. Provider-neutral generation input and normalized
// events are public; concrete transports remain private to this module.

export {
	collectModelClientContent,
	collectModelClientGeneration,
	ModelClientGenerationError,
	ModelClientProtocolError,
} from "./client";
export type { CollectedModelClientGeneration } from "./client";
export { createFakeModelClient } from "./fake";
export type { FakeModelClientReply } from "./fake";
export type {
	ModelClient,
	ModelClientEvent,
	ModelClientFinishReason,
	ModelClientFailureKind,
	ModelClientGenerationInput,
	ModelClientGenerationSettings,
	ModelClientConnectionSnapshot,
	ModelClientUsage,
} from "./types";
export {
	createDeepSeekModelClient,
	ModelClientTransportError,
} from "./deepseek";
export type { DeepSeekModelClientOptions } from "./deepseek";
export {
	resolveTestConnectionBackend,
	testDeepSeekConnection,
	TEST_CONNECTION_MAX_OUTPUT_TOKENS,
	TEST_CONNECTION_PROMPT,
	TEST_CONNECTION_TIMEOUT_MS,
} from "./test-connection";
export type {
	ModelFetch,
	TestConnectionFailureKind,
	TestConnectionInput,
	TestConnectionOptions,
	TestConnectionResult,
} from "./test-connection";
