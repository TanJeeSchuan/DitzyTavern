import type { NativePromptPreset } from "../shared/contract/prompt-preset";

// ==[HUMAN APPROVED]== Native-export download mechanics live outside the editor controller: one
// utility owns the filename derivation and the browser download.
const promptPresetFilename = (name: string): string =>
	`${name.trim().replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "prompt-preset"}.json`;

export function downloadNativePromptPreset(name: string, native: NativePromptPreset): void {
	const blob = new Blob([JSON.stringify(native, null, 2)], { type: "application/json" });
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = promptPresetFilename(name);
	anchor.click();
	URL.revokeObjectURL(url);
}
