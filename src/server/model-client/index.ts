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
} from "./types";
