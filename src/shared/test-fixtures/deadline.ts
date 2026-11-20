export async function withDeadline<T>(promise: Promise<T>, description: string, milliseconds = 5_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([promise, new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), milliseconds);
		})]);
	} finally {
		clearTimeout(timer);
	}
}
