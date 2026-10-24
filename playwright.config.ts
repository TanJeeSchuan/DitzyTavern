import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: ["e2e/**/*.spec.ts", "src/boxes/**/*.spec.ts"],
	fullyParallel: true,
	workers: "60%",
	globalSetup: "./e2e/global-setup.ts",
	outputDir: ".scratch/e2e-results",
	reporter: [["list"], ["html", { outputFolder: ".scratch/e2e-report", open: "never" }]],
	use: {
		viewport: { width: 1440, height: 900 },
		locale: "en-US",
		timezoneId: "UTC",
		contextOptions: { reducedMotion: "reduce" },
		screenshot: "only-on-failure",
	},
});
