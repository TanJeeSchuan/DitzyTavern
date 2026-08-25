import type {
	ModelClient,
	ModelClientGenerationInput,
} from "./types";

export type FakeModelClientReply = (
	input: ModelClientGenerationInput,
) => string | Promise<string>;

// Deterministic, network-free Model Client for workflow tests and local
// callers. The callback receives the exact generation input, which makes it
// possible to assert that the Prompt Plan crossed the seam unchanged.
export function createFakeModelClient(reply: FakeModelClientReply): ModelClient {
	return {
		async *generate(input) {
			const content = await reply(input);
			if (content !== "") {
				yield { type: "content", text: content };
			}
			yield { type: "finished", finishReason: "stop" };
		},
	};
}
