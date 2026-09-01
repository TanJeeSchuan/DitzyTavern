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

// ==[HUMAN APPROVED]== Human byte size. `nullLabel` covers the per-context absence wording
// ("n/a" in Chat information, empty in import presentation).
export const formatSize = (byteLength: number | null, nullLabel: string): string => {
	if (byteLength === null) return nullLabel;
	if (byteLength < 1024) return `${byteLength} B`;
	const kilobytes = byteLength / 1024;
	if (kilobytes < 1024) return `${kilobytes.toFixed(1)} KB`;
	return `${(kilobytes / 1024).toFixed(1)} MB`;
};
