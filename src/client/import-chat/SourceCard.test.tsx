import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { StagedChatHandle } from "../import-chat-flow";
import { SourceCard } from "./SourceCard";

const handle = (integrity: string | null): StagedChatHandle => ({
	token: "staged-token",
	sha256: "a".repeat(64),
	originalFilename: "export.jsonl",
	byteLength: 2048,
	integrity,
});

const counts = { messages: 12, variants: 17 };

describe("Import Source Card", () => {
	test("renders the shared source identity rows", () => {
		const markup = renderToStaticMarkup(
			<SourceCard handle={handle(null)} counts={counts} />,
		);

		expect(markup).toContain("import-source");
		expect(markup).toContain("Original filename");
		expect(markup).toContain("export.jsonl");
		expect(markup).toContain("a".repeat(64));
		expect(markup).toContain("2.0 KB");
		expect(markup).toContain("<dt>Messages</dt><dd>12</dd>");
		expect(markup).toContain("<dt>Variants</dt><dd>17</dd>");
	});

	test("renders the declared integrity row only for the Resolution step display", () => {
		const withIntegrity = renderToStaticMarkup(
			<SourceCard handle={handle("declared-sha")} counts={counts} showDeclaredIntegrity />,
		);
		expect(withIntegrity).toContain("Declared integrity");
		expect(withIntegrity).toContain("declared-sha");

		const reviewDisplay = renderToStaticMarkup(
			<SourceCard handle={handle("declared-sha")} counts={counts} />,
		);
		expect(reviewDisplay).not.toContain("Declared integrity");

		const missingIntegrity = renderToStaticMarkup(
			<SourceCard handle={handle(null)} counts={counts} showDeclaredIntegrity />,
		);
		expect(missingIntegrity).not.toContain("Declared integrity");
	});
});
