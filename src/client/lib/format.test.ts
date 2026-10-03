import { describe, expect, test } from "bun:test";
import { formatSize, formatTimestamp } from "./format";

describe("formatTimestamp", () => {
	test("an unparseable timestamp is echoed back unchanged", () => {
		expect(formatTimestamp("not-a-date")).toBe("not-a-date");
	});
});

describe("formatSize", () => {
	test("a null byte length renders the context's absence label", () => {
		expect(formatSize(null, "n/a")).toBe("n/a");
		expect(formatSize(null, "")).toBe("");
	});

	test("bytes below one kilobyte render with the B unit", () => {
		expect(formatSize(0, "n/a")).toBe("0 B");
		expect(formatSize(512, "n/a")).toBe("512 B");
		expect(formatSize(1023, "n/a")).toBe("1023 B");
	});

	test("kilobytes and megabytes render with one decimal", () => {
		expect(formatSize(1024, "n/a")).toBe("1.0 KB");
		expect(formatSize(2048, "n/a")).toBe("2.0 KB");
		expect(formatSize(1048576, "n/a")).toBe("1.0 MB");
		expect(formatSize(1572864, "n/a")).toBe("1.5 MB");
	});
});
