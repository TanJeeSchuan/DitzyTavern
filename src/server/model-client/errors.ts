import type { ModelClientFailureKind } from "./types";

export class ModelClientTransportError extends Error {
	readonly kind: ModelClientFailureKind;

	constructor(
		message: string,
		kind: ModelClientFailureKind = "transport",
	) {
		super(message);
		this.name = "ModelClientTransportError";
		this.kind = kind;
	}
}
