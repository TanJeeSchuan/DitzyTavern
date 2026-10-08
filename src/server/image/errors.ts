export class InvalidImageError extends Error {
	readonly outcome = "invalid" as const;
	constructor(message: string) {
		super(message);
		this.name = "InvalidImageError";
	}
}
