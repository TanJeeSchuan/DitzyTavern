import type { Preprocessor } from "knip";

const allowlist: Preprocessor = (report) => {
	// @approved
	// SAFETY: Knip supplies preprocessorOptions as the JSON object from knip.json.
	const allowed = JSON.parse(report.preprocessorOptions) as Record<string, string[]>;
	for (const [file, symbols] of Object.entries(allowed)) {
		for (const kind of ["exports", "types"] as const) {
			const issues = report.issues[kind][file];
			if (issues === undefined) continue;
			for (const symbol of symbols) {
				if (!Object.hasOwn(issues, symbol)) continue;
				delete issues[symbol];
				report.counters[kind]--;
			}
		}
	}
	return report;
};

export default allowlist;
