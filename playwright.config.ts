import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "e2e",
	testMatch: "**/*.spec.ts",
	globalSetup: "./e2e/global-setup.ts",
	outputDir: ".scratch/e2e-results",
	reporter: [["list"], ["html", { outputFolder: ".scratch/e2e-report", open: "never" }]],
	use: {
		viewport: { width: 1440, height: 900 },
		locale: "en-US",
		timezoneId: "UTC",
		contextOptions: { reducedMotion: "reduce" },
		trace: "retain-on-failure",
	},
});
