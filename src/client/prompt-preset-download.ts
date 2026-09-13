import type { NativePromptPreset } from "../shared/contract/prompt-preset";
import { downloadFileInBrowser } from "./lib/download";

// ==[HUMAN APPROVED]== Native-export download mechanics live outside the editor controller: one
// utility owns the filename derivation and the browser download.
const promptPresetFilename = (name: string): string =>
	`${name.trim().replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "prompt-preset"}.json`;

export function downloadNativePromptPreset(name: string, native: NativePromptPreset): void {
	downloadFileInBrowser(
		promptPresetFilename(name),
		"application/json",
		new TextEncoder().encode(JSON.stringify(native, null, 2)),
	);
}
