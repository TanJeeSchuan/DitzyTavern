export class InvalidImageError extends Error {
	readonly outcome = "invalid" as const;
	readonly details = { reason: this.message };
	constructor(message: string) {
		super(message);
		this.name = "InvalidImageError";
	}
}
