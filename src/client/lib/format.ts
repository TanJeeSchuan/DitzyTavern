// ==[HUMAN APPROVED]== Shared client formatters. One definition per presentation concern so the
// wording and units can never drift between panels.

// ==[HUMAN APPROVED]== Renders a wire timestamp in the viewer's locale; unparseable input is
// echoed back unchanged.
export const formatTimestamp = (value: string): string => {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return value;
	}
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(date);
};

export const formatJudgment = (value: string) => value.replace("_", " ").replace(/^./, (letter) => letter.toUpperCase());

// ==[HUMAN APPROVED]== Human byte size. `nullLabel` covers the per-context absence wording
// ("n/a" in Chat information, empty in import presentation).
export const formatSize = (byteLength: number | null, nullLabel: string): string => {
	if (byteLength === null) return nullLabel;
	if (byteLength < 1024) return `${byteLength} B`;
	const kilobytes = byteLength / 1024;
	if (kilobytes < 1024) return `${kilobytes.toFixed(1)} KB`;
	return `${(kilobytes / 1024).toFixed(1)} MB`;
};

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
const daysAgo = (date: Date, now: Date) => Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);

export const formatListTime = (value: string, now = new Date()): string => {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	const days = daysAgo(date, now);
	if (days === 0) return new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(date);
	if (days < 7) return new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(date);
	return new Intl.DateTimeFormat(undefined, date.getFullYear() === now.getFullYear() ? { month: "short", day: "numeric" } : { dateStyle: "medium" }).format(date);
};

export const recencyGroup = (value: string, now = new Date()): "Today" | "This week" | "Earlier" => {
	const days = daysAgo(new Date(value), now);
	return days === 0 ? "Today" : days < 7 ? "This week" : "Earlier";
};
