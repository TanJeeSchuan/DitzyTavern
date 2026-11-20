import { defineConfig } from "@playwright/test";
import base from "../playwright.config";

export default defineConfig(base, {
	testDir: "..",
	testMatch: "e2e/ui-eval/*.spec.ts",
	testIgnore: [],
	globalSetup: "./global-setup.ts",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 120_000,
	outputDir: "../.scratch/ui-eval-results",
	reporter: [["list"], ["./ui-eval/reporter.ts"]],
	use: { contextOptions: { reducedMotion: "no-preference" } },
});
