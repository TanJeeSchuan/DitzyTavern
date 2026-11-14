import { test, expect } from "../fixtures";
import { installProbe } from "./probe";

test("the probe observes visibility changes caused only by CSS", async ({ page }, testInfo) => {
	await page.addInitScript(installProbe);
	const html = `<style>
		#result { opacity: 0 }
		#result.show { animation: reveal 100ms 80ms forwards }
		@keyframes reveal { from { opacity: 0 } to { opacity: 1 } }
	</style><button id="reveal" onclick="document.querySelector('#result').className='show'">Reveal</button><div id="result">Ready</div>`;
	await page.goto(`data:text/html,${encodeURIComponent(html)}`);
	await page.evaluate(() => window.uiEval.arm({
		name: "probe validation: CSS visibility", budgetMs: 400, timeoutMs: 500, warmup: false,
		trigger: { kind: "click", selector: "#reveal" }, result: { selector: "#result", text: "Ready" },
	}));
	await page.getByRole("button", { name: "Reveal" }).click();
	const sample = await page.evaluate(() => window.uiEval.result());
	await testInfo.attach("ui-eval.json", { body: JSON.stringify({ samples: [sample] }), contentType: "application/json" });
	expect(sample.outcome, "CSS visibility can change after the final DOM mutation").toBe("observed");
});
