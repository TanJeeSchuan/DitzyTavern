import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Composer } from "./Composer";

describe("Composer", () => {
	test("renders story continuation placeholder for message drafts", () => {
		const markup = renderToStaticMarkup(
			<Composer
				draft=""
				isGenerating={false}
				canWrite={true}
				isReceded={false}
				onDraftChange={() => {}}
				onFocusChange={() => {}}
				onSubmit={() => {}}
			/>,
		);

		expect(markup).toContain('placeholder="Write a message to continue the story…"');
	});
});
