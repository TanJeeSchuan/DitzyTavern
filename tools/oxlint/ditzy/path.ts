const normalized = (value: string): string => value.replaceAll("\\", "/");

/** Return a stable repository-relative path for Oxlint and RuleTester filenames. */
export const repositoryPath = (filename: string): string => {
	const path = normalized(filename);
	for (const marker of ["/src/", "/tools/", "/scripts/"]) {
		const index = path.lastIndexOf(marker);
		if (index >= 0) return path.slice(index + 1);
	}
	return path.replace(/^\.\//, "");
};

export const isTestFile = (filename: string): boolean =>
	/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(repositoryPath(filename));
