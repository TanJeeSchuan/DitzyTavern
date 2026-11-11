import { mkdirSync, writeFileSync } from "node:fs";
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import { Value } from "@sinclair/typebox/value";
import { Type } from "@sinclair/typebox";
import { samplesSchema, type Sample } from "./probe";

export default class UiEvalReporter implements Reporter {
	private samples: Sample[] = [];

	onTestEnd(_test: TestCase, result: TestResult) {
		const repetitions = result.attachments.find((attachment) => attachment.name === "ui-eval-samples.json")?.body;
		const log = result.attachments.find((attachment) => attachment.name === "ui-eval.json")?.body;
		if (repetitions) this.samples.push(...Value.Parse(samplesSchema, JSON.parse(repetitions.toString())));
		else if (log) this.samples.push(...Value.Parse(Type.Object({ samples: samplesSchema }), JSON.parse(log.toString())).samples);
	}

	onEnd() {
		const measured = this.samples.filter((sample) => !sample.warmup && !sample.name.startsWith("probe validation:"));
		const lines = [
			"# UI responsiveness eval", "",
			"Budgets are informational during baseline collection. Functional assertions and probe validation fail the job.", "",
			"Times end after a render opportunity, not confirmed pixel presentation. Timed-out samples are lower bounds and are excluded from completed-sample medians.", "",
			"| Scenario | Budget ms | Samples | Completed median ms | Completed max ms | Timeouts | Budget misses | Unavailable |",
			"| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
		];
		for (const name of new Set(measured.map((sample) => sample.name))) {
			const group = measured.filter((sample) => sample.name === name);
			const available = group.filter((sample) => sample.outcome !== "unavailable");
			const completed = available.filter((sample) => sample.outcome === "observed").map((sample) => sample.durationMs).sort((left, right) => left - right);
			const middle = Math.floor(completed.length / 2);
			const lowerMiddle = Math.max(0, Math.ceil(completed.length / 2) - 1);
			const median = completed.length === 0 ? "—" : ((completed[middle]! + completed[lowerMiddle]!) / 2).toFixed(1);
			const maximum = completed.at(-1)?.toFixed(1) ?? "—";
			const timeouts = available.filter((sample) => sample.outcome === "timed-out");
			const misses = available.filter((sample) => sample.durationMs > sample.budgetMs).length;
			const lowerBound = Math.min(...timeouts.map((sample) => sample.durationMs)).toFixed(0);
			const censored = timeouts.length ? `${timeouts.length} (≥${lowerBound} ms)` : "0";
			const budgetMisses = available.length ? `${misses}/${available.length}` : "—";
			const unavailable = group.filter((sample) => sample.outcome === "unavailable").map((sample) => sample.reason).join(" ");
			lines.push(`| ${name} | ${group[0]!.budgetMs} | ${available.length} | ${median} | ${maximum} | ${censored} | ${budgetMisses} | ${unavailable} |`);
		}
		lines.push("", "The first repetition of Swipe, Stop and typing is excluded as warmup. The injected 500 ms stall is validation, not an app sample.", "");
		mkdirSync(".scratch/ui-eval", { recursive: true });
		writeFileSync(".scratch/ui-eval/samples.json", JSON.stringify(this.samples, null, 2));
		writeFileSync(".scratch/ui-eval/summary.md", lines.join("\n"));
		process.stdout.write(`\n${lines.join("\n")}`);
	}
}
