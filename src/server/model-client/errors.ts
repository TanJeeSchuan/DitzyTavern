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
