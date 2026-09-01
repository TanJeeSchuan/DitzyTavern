import { scheduler } from "node:timers/promises";
import type {
	ModelClient,
	ModelClientEvent,
	ModelClientFailureKind,
	ModelClientGenerationInput,
	ModelClientUsage,
} from "./types";

export class ModelClientProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ModelClientProtocolError";
	}
}

export class ModelClientGenerationError extends Error {
	readonly kind: ModelClientFailureKind;
	readonly partial: Partial<CollectedModelClientGeneration>;

	constructor(
		kind: ModelClientFailureKind,
		message: string,
		partial: Partial<CollectedModelClientGeneration> = {},
	) {
		super(sanitizeGenerationMessage(message));
		this.name = "ModelClientGenerationError";
		this.kind = kind;
		this.partial = partial;
	}
}

function sanitizeGenerationMessage(message: string): string {
	return Array.from(message, (character) => {
		const code = character.codePointAt(0) ?? 32;
		return code < 32 || code === 127 ? " " : character;
	}).join("").slice(0, 16_384);
}

export interface CollectedModelClientGeneration {
	readonly content: string;
	readonly reasoning: string;
	readonly usage: ModelClientUsage | null;
	readonly finishReason: "stop" | "length" | "other";
}

type MutableCollectedModelClientGeneration = {
	-readonly [Key in keyof CollectedModelClientGeneration]: CollectedModelClientGeneration[Key];
};

export async function collectModelClientGeneration(
	client: ModelClient,
	input: ModelClientGenerationInput,
	options: { readonly onEvent?: (event: ModelClientEvent) => void | Promise<void> } = {},
): Promise<CollectedModelClientGeneration> {
	let content = "";
	let reasoning = "";
	let usage: ModelClientUsage | null = null;
	let finished: Extract<ModelClientEvent, { type: "finished" }> | null = null;
	let eventsSinceYield = 0;

	try {
		for await (const event of client.generate(input)) {
			if (finished !== null) {
				throw new ModelClientProtocolError(
					"A Model Client emitted an event after its finished outcome.",
				);
			}
			await options.onEvent?.(event);

			switch (event.type) {
				case "content":
					content += event.text;
					break;
				case "reasoning":
					reasoning += event.text;
					break;
				case "usage":
					usage = event.usage;
					break;
				case "keepalive":
					break;
				case "finished":
					finished = event;
					break;
				case "failed":
					throw new ModelClientGenerationError(event.kind, event.message);
				default:
					assertNeverModelClientEvent(event);
			}
			// An async iterator can resolve every read from its in-memory queue. A
			// plain await then remains in the microtask queue and starves Elysia's
			// request dispatcher until the provider stream drains. Bound each burst
			// without adding a scheduling turn to ordinary short streams.
			eventsSinceYield += 1;
			if (eventsSinceYield >= 32) {
				eventsSinceYield = 0;
				await scheduler.yield();
			}
		}
	} catch (error) {
		const partial: Partial<MutableCollectedModelClientGeneration> = { content, reasoning, usage };
		if (finished !== null) {
			partial.finishReason = finished.finishReason;
		}
		if (error instanceof ModelClientGenerationError) {
			throw new ModelClientGenerationError(error.kind, error.message, partial);
		}
		if (error instanceof Error && isModelClientFailure(error)) {
			throw new ModelClientGenerationError(error.kind, error.message, partial);
		}
		throw error;
	}

	if (finished === null) {
		throw new ModelClientProtocolError(
			"A Model Client stream ended without a finished outcome.",
		);
	}

	return {
		content,
		reasoning,
		usage,
		finishReason: finished.finishReason,
	};
}

function isModelClientFailure(
	error: Error,
): error is Error & { kind: ModelClientFailureKind } {
	// SAFETY: Model Client transport errors extend Error and carry one of the
	// closed failure kinds before this predicate is called.
	const candidate = error as Error & { kind?: ModelClientFailureKind };
	const kind = candidate.kind;
	return (
		kind !== undefined &&
		(kind === "cancelled" ||
			kind === "inactivity" ||
			kind === "transport" ||
			kind === "provider" ||
			kind === "protocol")
	);
}

const assertNeverModelClientEvent = (event: never): never => {
	throw new ModelClientProtocolError(
		`Unsupported Model Client event: ${JSON.stringify(event)}.`,
	);
};

export type { ModelClientEvent } from "./types";
