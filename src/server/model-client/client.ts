import type {
	ModelClient,
	ModelClientGenerationInput,
} from "./types";

export class ModelClientProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ModelClientProtocolError";
	}
}

// Collects the ordinary full Message result while keeping the transport
// contract asynchronous and event-based. Future streaming workflows can
// consume the same normalized events incrementally without changing the
// Model Client boundary.
export async function collectModelClientContent(
	client: ModelClient,
	input: ModelClientGenerationInput,
): Promise<string> {
	let content = "";
	let finished = false;

	for await (const event of client.generate(input)) {
		if (finished) {
			throw new ModelClientProtocolError(
				"A Model Client emitted an event after its finished outcome.",
			);
		}

		switch (event.type) {
			case "content":
				content += event.text;
				break;
			case "finished":
				finished = true;
				break;
			default:
				assertNeverModelClientEvent(event);
		}
	}

	if (!finished) {
		throw new ModelClientProtocolError(
			"A Model Client stream ended without a finished outcome.",
		);
	}

	return content;
}

const assertNeverModelClientEvent = (event: never): never => {
	throw new ModelClientProtocolError(
		`Unsupported Model Client event: ${JSON.stringify(event)}.`,
	);
};

export type { ModelClientEvent } from "./types";
