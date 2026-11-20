import { matchesGlob } from "node:path";
import type { Preprocessor } from "knip";

const allowlist: Preprocessor = (report) => {
	// @approved
	// SAFETY: Knip supplies preprocessorOptions as the JSON object from knip.json.
	const allowed = JSON.parse(report.preprocessorOptions) as Record<string, string[]>;
	for (const kind of ["exports", "types"] as const) {
		for (const [file, issues] of Object.entries(report.issues[kind])) {
			for (const [pattern, symbols] of Object.entries(allowed)) {
				if (!matchesGlob(file, pattern)) continue;
				for (const symbol of symbols) {
					if (!Object.hasOwn(issues, symbol)) continue;
					delete issues[symbol];
					report.counters[kind]--;
				}
			}
		}
	}
	return report;
};

export default allowlist;
