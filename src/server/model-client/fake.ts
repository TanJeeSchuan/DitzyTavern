import type {
	ModelClient,
	ModelClientEvent,
	ModelClientGenerationInput,
} from "./types";

export type FakeModelClientEvents =
	| readonly ModelClientEvent[]
	| AsyncIterable<ModelClientEvent>;

export type FakeModelClientReply = (
	input: ModelClientGenerationInput,
) => string | FakeModelClientEvents | Promise<string | FakeModelClientEvents>;

// @approved
//  Deterministic, network-free Model Client for workflow tests and local
// callers. The callback receives the exact generation input, which makes it
// possible to assert that the Prompt Plan crossed the seam unchanged.
export function createFakeModelClient(reply: FakeModelClientReply): ModelClient {
	return {
		async *generate(input) {
			const result = await reply(input);
			if (isTextReply(result)) {
				// @approved
				//  SAFETY: the fake reply union has exactly one primitive branch,
				// string; all event replies are objects.
				if (result !== "") {
					yield { type: "content", text: result };
				}
				yield { type: "finished", finishReason: "stop" };
				return;
			}
			if (isAsyncIterable(result)) {
				for await (const event of result) yield event;
				return;
			}
			for (const event of result) yield event;
		},
	};
}

function isTextReply(value: string | FakeModelClientEvents): value is string {
	return Object(value) !== value;
}

function isAsyncIterable(value: FakeModelClientEvents): value is AsyncIterable<ModelClientEvent> {
	return Symbol.asyncIterator in Object(value);
}
