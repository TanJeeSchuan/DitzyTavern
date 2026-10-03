export type InvalidImageReason = "unsupported-type" | "too-large" | "malformed";

export class InvalidImageError extends Error {
	readonly reason: InvalidImageReason;

	constructor(reason: InvalidImageReason, message: string) {
		super(message);
		this.name = "InvalidImageError";
		this.reason = reason;
	}
}
