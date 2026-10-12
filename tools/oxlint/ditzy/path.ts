import { posix } from "node:path";

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

/** The repository path an import names, without its extension, or undefined for a package. */
export const importTarget = (filename: string, source: string): string | undefined => {
	const path = normalized(source);
	const local = path.startsWith("@/") ? `src/${path.slice(2)}`
		: path.startsWith(".") ? posix.join(posix.dirname(repositoryPath(filename)), path)
		: path.startsWith("/") || /^[A-Za-z]:\//.test(path) ? repositoryPath(path)
		: undefined;
	return local === undefined ? undefined : posix.normalize(local).replace(/\.[cm]?[jt]sx?$/, "");
};

/** A Box or Box SDK file's layer comes from its file name; any other file's from its top-level folder under src. */
export const layerOf = (path: string): "client" | "server" | "shared" | undefined => {
	const name = /^src\/(?:boxes\/[^/]+|box-sdk)\/([^/]+)$/.exec(path)?.[1];
	if (name === undefined) {
		const layer = /^src\/(client|server|shared)(?:\/|$)/.exec(path)?.[1];
		return layer === "client" || layer === "server" || layer === "shared" ? layer : undefined;
	}
	if (name.startsWith("server")) return "server";
	if (name.startsWith("client")) return "client";
	return name.startsWith("shared") || name.startsWith("contract") ? "shared" : undefined;
};
