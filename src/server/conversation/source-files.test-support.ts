import { readdirSync } from "node:fs";
import { join } from "node:path";

export const collectTypeScriptSourceFiles = (
	directory: string,
	files: string[] = [],
): string[] => {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const fullPath = join(directory, entry.name);
		if (entry.isDirectory()) {
			collectTypeScriptSourceFiles(fullPath, files);
		} else if (/\.(ts|tsx)$/.test(entry.name)) {
			files.push(fullPath);
		}
	}
	return files;
};
