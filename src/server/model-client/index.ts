// ==[HUMAN APPROVED]== Deep Model Client seam. Provider-neutral generation input and normalized
// events are public; concrete transports remain private to this module.

export {
	collectModelClientGeneration,
	ModelClientGenerationError,
	ModelClientProtocolError,
} from "./client";
export type { CollectedModelClientGeneration } from "./client";
export { createFakeModelClient } from "./fake";
export type { FakeModelClientReply } from "./fake";
export {
	projectModelClientGenerationSettings,
} from "./generation-settings";
export type {
	ModelClient,
	ModelClientEvent,
	ModelClientFinishReason,
	ModelClientFailureKind,
	ModelClientGenerationInput,
	ModelClientGenerationSettings,
	AssistantPrefill,
	ModelClientConnectionSnapshot,
	ModelClientUsage,
	ModelFetch,
} from "./types";
export {
	createModelClient,
	createDeepSeekModelClient,
	createOpenRouterModelClient,
	createOpenAICompatibleModelClient,
	normalizeUsage,
	ModelClientTransportError,
} from "./chat-completions";
export type {
	ChatCompletionsModelClientOptions,
} from "./chat-completions";
export {
	testConnection,
	TEST_CONNECTION_MAX_OUTPUT_TOKENS,
	TEST_CONNECTION_PROMPT,
	TEST_CONNECTION_TIMEOUT_MS,
} from "./test-connection";
export { cosineSimilarity, EmbeddingServiceError, requestEmbeddings } from "./embeddings";
export {
	discoverModels,
	normalizeDiscoveryCatalog,
} from "./discovery";
export type {
	DiscoveryFailureKind,
	DiscoveryInput,
	DiscoveryOptions,
	DiscoveryResult,
} from "./discovery";
export type {
	TestConnectionFailureKind,
	TestConnectionInput,
	TestConnectionOptions,
	TestConnectionResult,
} from "./test-connection";
