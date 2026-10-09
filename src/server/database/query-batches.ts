/** @approved SQLite caps the variables in one statement, so large ID sets query in batches of 500. */
export const queryBatches = <T>(values: readonly T[]): T[][] =>
	Array.from({ length: Math.ceil(values.length / 500) }, (_, index) =>
		values.slice(index * 500, (index + 1) * 500),
	);
