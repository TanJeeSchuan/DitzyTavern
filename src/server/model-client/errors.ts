import type { ModelClientFailureKind } from "./types";

export class ModelClientTransportError extends Error {
	readonly kind: ModelClientFailureKind;

	constructor(
		message: string,
		kind: ModelClientFailureKind = "transport",
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "ModelClientTransportError";
		this.kind = kind;
	}
}

export function toModelClientTransportError(
	error: ErrorOptions["cause"],
): ModelClientTransportError {
	let message = "The provider request failed.";
	if (error instanceof Error) {
		if (error.name === "AbortError") {
			message = "The provider did not respond before the Connection Profile timeout.";
		} else if (error.message.trim().length > 0) {
			message = "The provider request failed: an adapter error occurred.";
		}
	}
	return new ModelClientTransportError(message, "transport", { cause: error });
}
