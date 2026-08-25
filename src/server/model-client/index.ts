// Deep Model Client seam. Provider-neutral generation input and normalized
// events are public; concrete transports remain private to this module.

export { collectModelClientContent, ModelClientProtocolError } from "./client";
export { createFakeModelClient } from "./fake";
export type { FakeModelClientReply } from "./fake";
export type {
	ModelClient,
	ModelClientEvent,
	ModelClientFinishReason,
	ModelClientGenerationInput,
	ModelClientGenerationSettings,
	ModelClientConnectionSnapshot,
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
