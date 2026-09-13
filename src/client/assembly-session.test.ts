import { describe, expect, test } from "bun:test";
import type { GenerationPreview, GenerationPreviewBody } from "./conversation";
import {
	reduceAssemblySession,
	type AssemblySession,
} from "./assembly-session";
import type { PromptPlan } from "../shared/contract/conversation-schema";

const request: GenerationPreviewBody = { kind: "send", content: "Draft" };
const plan = (content: string): PromptPlan => ({
	blocks: [{ kind: "instruction", role: "system", content }],
	warnings: [],
});
const preview = (content = "Expanded"): GenerationPreview => ({
	outcome: "available",
	previewId: "preview-1",
	conversationId: 7,
	kind: "send",
	promptPlan: plan(content),
	participants: { human: null, model: null },
	// SAFETY: the reducer tests only inspect plan and lifecycle fields; settings are not exercised.
	effectiveSettings: {} as GenerationPreview["effectiveSettings"],
	pendingWrites: [],
	budget: {
		tokenEstimate: 1,
		responseBudget: 1,
		safetyAllowance: 1,
		contextLimit: 10,
		totalRequiredTokens: 3,
		budgetFits: true,
	},
});

const started = (): AssemblySession => reduceAssemblySession(null, {
	type: "started",
	requestId: 1,
	request,
})!;

describe("assembly session", () => {
	test("reserves the session and ignores stale preview responses", () => {
		const first = started();
		const replaced = reduceAssemblySession(first, {
			type: "started",
			requestId: 2,
			request,
		})!;

		expect(reduceAssemblySession(replaced, {
			type: "preview-available",
			requestId: 1,
			preview: preview(),
		})).toEqual(replaced);
		expect(reduceAssemblySession(replaced, {
			type: "preview-available",
			requestId: 2,
			preview: preview(),
		})?.phase).toBe("ready");
	});

	test("keeps an edited plan and allows acceptance retry after failure", () => {
		const ready = reduceAssemblySession(started(), {
			type: "preview-available",
			requestId: 1,
			preview: preview(),
		})!;
		const edited = reduceAssemblySession(ready, {
			type: "plan-edited",
			requestId: 1,
			promptPlan: plan("Edited"),
		})!;
		const accepting = reduceAssemblySession(edited, {
			type: "acceptance-started",
			requestId: 1,
		})!;
		const failed = reduceAssemblySession(accepting, {
			type: "acceptance-failed",
			requestId: 1,
			error: "Stale Conversation.",
		})!;

		expect(failed.phase).toBe("failed");
		expect(failed.error).toBe("Stale Conversation.");
		expect(failed.preview?.promptPlan.blocks[0]?.content).toBe("Edited");
		expect(reduceAssemblySession(failed, { type: "acceptance-started", requestId: 1 })?.phase).toBe("accepting");
	});

	test("acceptance is a one-shot transition and cancellation closes the session", () => {
		const ready = reduceAssemblySession(started(), {
			type: "preview-available",
			requestId: 1,
			preview: preview(),
		})!;
		const accepting = reduceAssemblySession(ready, { type: "acceptance-started", requestId: 1 })!;
		expect(reduceAssemblySession(accepting, { type: "acceptance-started", requestId: 1 })).toEqual(accepting);
		expect(reduceAssemblySession(accepting, { type: "acceptance-succeeded", requestId: 1 })).toBeNull();
		expect(reduceAssemblySession(accepting, { type: "cancelled", requestId: 1 })).toBeNull();
	});

	test("conversation switching closes the session", () => {
		const ready = reduceAssemblySession(started(), {
			type: "preview-available",
			requestId: 1,
			preview: preview(),
		})!;

		expect(reduceAssemblySession(ready, { type: "conversation-switched" })).toBeNull();
	});
});
