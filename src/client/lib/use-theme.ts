import { useState } from "react";
import type { ThemePreference } from "../workspace";

const THEME_KEY = "ditzytavern-theme";

// @approved
// Persists the daylight/evening/system choice; applying it to the document
// stays with the presentation that owns the workspace.
export function useThemePreference() {
	const [theme, setTheme] = useState<ThemePreference>(() => {
		const saved = window.localStorage.getItem(THEME_KEY);
		return saved === "daylight" || saved === "evening" ? saved : "system";
	});
	const setPersistedTheme = (next: ThemePreference) => {
		window.localStorage.setItem(THEME_KEY, next);
		setTheme(next);
	};
	return [theme, setPersistedTheme] as const;
}
