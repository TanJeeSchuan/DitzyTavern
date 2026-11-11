import type { Locator } from "@playwright/test";
import { Value } from "@sinclair/typebox/value";
import { test, expect } from "../fixtures";
import { workspaceResponse } from "../../src/shared/contract/workspace";
import { conversationPromptPreset } from "../../src/shared/contract/prompt-preset";
import { installProbe, type Measurement, type Sample } from "./probe";
import { discoverControls, type Coverage } from "./crawl";

test("crawl Prompt Preset controls", async ({ page, request, llm }, testInfo) => {
	test.setTimeout(300_000);
	await page.addInitScript(installProbe);
	const samples: Sample[] = [];
	const coverage = new Map<string, Coverage>();
	const panel = page.locator(".primary-panel");
	const saveStatus = ".primary-panel .save-footer [role=status]";
	const discover = async (root: Locator, state: string) => {
		const controls = await discoverControls(root, state);
		for (const control of controls) {
			if (!coverage.has(control.key)) coverage.set(control.key, {
				key: control.key, state, role: control.role, name: control.name,
				initiallyDisabled: control.initiallyDisabled, contract: control.contract, samples: 0,
			});
		}
		return controls;
	};
	const measure = async (name: string, trigger: string, result: Measurement["result"], action: () => Promise<void>, key?: string) => {
		await page.evaluate((config) => window.uiEval.arm(config), {
			name, budgetMs: 400, timeoutMs: 5000, warmup: false,
			trigger: { kind: "click", selector: trigger }, result,
		} satisfies Measurement);
		await action();
		const sample = await page.evaluate(() => window.uiEval.result());
		samples.push(sample);
		expect(sample.outcome, `${name} reaches its completion condition`).toBe("observed");
		if (key !== undefined) coverage.get(key)!.samples++;
	};
	const open = async () => {
		await page.goto("about:blank");
		await llm.reset();
		await page.goto("/");
		const navigation = page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Prompt Presets", exact: true });
		await navigation.evaluate((element) => element.setAttribute("data-ui-eval-control", "open-presets"));
		await measure("crawl / Prompt Presets / open", '[data-ui-eval-control="open-presets"]', {
			selector: '.primary-panel:has([aria-label="Preset contents"] [role=switch]:not(:disabled)) .save-footer [role=status]', text: "Saved",
		}, () => navigation.click());
		const workspace = Value.Parse(workspaceResponse, await (await request.get("/api/workspace")).json());
		const url = `/api/conversations/${workspace.activeChatId}/prompt-preset`;
		const recipe = Value.Parse(conversationPromptPreset, await (await request.get(url)).json());
		return { controls: await discover(panel, "Prompt Presets"), recipe, url };
	};
	try {
		const initial = await open();
		const targets = initial.controls.filter((control) => control.contract === "toggle draft" || control.contract === "entry details");
		expect(targets.length, "the crawl exercises seeded preset entries").toBeGreaterThan(0);
		for (const target of targets) {
			for (let repetition = 0; repetition < 3; repetition++) {
				for (const next of target.contract === "toggle draft" ? [false, true] : [false]) {
					const state = await open();
					const control = state.controls.find((candidate) => candidate.key === target.key)!;
					expect(control, "the seeded control has the same identity after reset").toBeDefined();
					const entry = `entry ${control.rowIndex + 1}: ${control.rowTitle}`;
					if (control.contract === "toggle draft") {
						const save = state.controls.find((candidate) => candidate.contract === "save draft")!;
						if (await control.locator.isChecked() === next) {
							await control.locator.click();
							await save.locator.click();
							await expect(page.locator(saveStatus)).toHaveText("Saved");
						}
						const expected = `${control.selector}[aria-checked="${next}"]`;
						const name = `crawl / ${entry} / ${next ? "enable" : "disable"}`;
						await measure(`${name} draft`, control.selector, {
							selector: `.primary-panel:has(${expected}) .save-footer [role=status]`, text: "Unsaved changes",
						}, () => control.locator.click(), control.key);
						const slot = state.recipe.slots[control.rowIndex]!;
						await measure(`${name} save`, save.selector, {
							selector: `.primary-panel:has(${expected}) .save-footer [role=status]`, text: "Saved",
						}, () => save.locator.click(), save.key);
						const persisted = Value.Parse(conversationPromptPreset, await (await request.get(state.url)).json());
						expect(persisted.slots.find((candidate) => candidate.id === slot.id)?.enabled, "Save persists the selected entry's actual enabled state").toBe(next);
					} else {
						await measure(`crawl / ${entry} / details`, control.selector, {
							selector: '[role=dialog][data-state=open]:has(h2):has(textarea:not(:disabled), dl dd):has(button:not(:disabled))',
						}, () => control.locator.click(), control.key);
						const dialog = page.getByRole("dialog");
						const name = dialog.getByRole("textbox", { name: "Name", exact: true });
						if (await name.count()) expect(await name.inputValue(), "the detail editor belongs to the selected entry").toBe(control.rowTitle);
						else expect(await dialog.getByRole("heading").textContent(), "the detail panel belongs to the selected entry").toBe(control.rowTitle);
						await discover(dialog, `Prompt Presets / ${entry} details`);
						await dialog.getByRole("button", { name: "Done", exact: true }).click();
						await expect(dialog).toBeHidden();
					}
				}
			}
		}
	} finally {
		await testInfo.attach("ui-eval-samples.json", { body: JSON.stringify(samples), contentType: "application/json" });
		await testInfo.attach("ui-eval-coverage.json", { body: JSON.stringify([...coverage.values()]), contentType: "application/json" });
	}
});
