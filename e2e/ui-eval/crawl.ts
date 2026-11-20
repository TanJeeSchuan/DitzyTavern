import type { Locator } from "@playwright/test";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const coverageSchema = Type.Array(Type.Object({
	key: Type.String(), state: Type.String(), role: Type.String(), name: Type.String(),
	initiallyDisabled: Type.Boolean(), samples: Type.Integer(),
	contract: Type.Union([Type.Literal("toggle draft"), Type.Literal("entry details"), Type.Literal("save draft"), Type.Null()]),
}));
export type Coverage = Static<typeof coverageSchema>[number];

const roles = ["button", "switch", "checkbox", "combobox", "textbox", "spinbutton", "slider", "radio", "tab", "link", "menuitem", "option"] satisfies Parameters<Locator["getByRole"]>[0][];

export async function discoverControls(root: Locator, state: string) {
	const controls = [];
	for (const role of roles) {
		for (const [position, locator] of (await root.getByRole(role).all()).entries()) {
			if (!await locator.isVisible()) continue;
			const snapshot = await locator.ariaSnapshot();
			const quotedName = snapshot.match(/^-\s+\S+(?:\s+("(?:\\.|[^"\\])*"))?/)?.[1];
			const name = quotedName === undefined ? "" : Value.Parse(Type.String(), JSON.parse(quotedName));
			const context = await locator.evaluate((element) => {
				const row = element.closest("li");
				return {
					rowIndex: row === null ? -1 : [...(row.parentElement?.children ?? [])].indexOf(row),
					rowTitle: row?.querySelector("h3")?.textContent?.trim() ?? "",
					popup: element.getAttribute("aria-haspopup"), footer: element.closest(".save-footer") !== null,
				};
			});
			const key = `${state} / ${context.rowIndex < 0 ? "panel" : `entry ${context.rowIndex + 1}: ${context.rowTitle}`} / ${role}: ${name || "(unnamed)"} / ${position}`;
			const contract: Coverage["contract"] = role === "switch" && context.rowIndex >= 0 ? "toggle draft"
				: role === "button" && context.popup === "dialog" && context.rowIndex >= 0 ? "entry details"
				: role === "button" && context.footer ? "save draft" : null;
			controls.push({ key, state, role, name, ...context, contract, locator, initiallyDisabled: !await locator.isEnabled() });
		}
	}
	controls.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
	return Promise.all(controls.map(async (control, index) => {
		const marker = `${state}:${index}`;
		await control.locator.evaluate((element, value) => element.setAttribute("data-ui-eval-control", value), marker);
		return { ...control, selector: `[data-ui-eval-control=${JSON.stringify(marker)}]` };
	}));
}
