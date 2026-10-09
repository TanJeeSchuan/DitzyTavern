import { describe, expect, test } from "bun:test";
import { presentDomainError } from "./domain-error";
import { InvalidConversationCommandError } from "../conversation";
import { StaleRevisionError } from "../revision";
import { PromptPresetDeletionImpactChangedError } from "../prompt-preset";
import { generationConflictResponse } from "../../shared/contract/conversation-schema";
import { promptPresetCommandConflict } from "../../shared/contract/prompt-preset";
import { invalidOutcome, notFoundOutcome, notPlayableOutcome } from "../../shared/contract/outcomes";

describe("domain error presentation", () => {
	test("keeps unexpected throws and undeclared outcomes outside the route contract", () => {
		const bug = new Error("Unexpected database failure");
		for (const cause of [bug, "provider failure", new InvalidConversationCommandError("invalid")]) {
			try {
				presentDomainError(cause, { 404: notFoundOutcome });
				throw new Error("Expected the original failure");
			} catch (error) {
				expect(error).toBe(cause);
			}
		}
	});

	test("presents a nested deletion-impact union with its authoritative preset", () => {
		const preset = { id: 9, name: "Changed", revision: 2, isDefault: false, conversationCount: 3 };
		const error = new PromptPresetDeletionImpactChangedError(1, preset);
		const result = presentDomainError(error, { 409: promptPresetCommandConflict });
		expect(result).toMatchObject({ code: 409, response: {
			outcome: "conflict", reason: "deletion-impact", currentPreset: preset,
		} });
		expect(Object.keys(result.response)).toEqual(["outcome", "reason", "currentPreset"]);
	});

	test("generation starts report stale revisions as prose while undeclared envelopes rethrow", () => {
		const stale = new StaleRevisionError("generation", 2, 3);
		expect(presentDomainError(stale, { 409: generationConflictResponse })).toMatchObject({
			code: 409, response: { outcome: "conflict", reason: stale.message },
		});
		expect(() => presentDomainError(stale, { 409: notPlayableOutcome })).toThrow(stale);
	});

	test("only declared details enter the payload", () => {
		const error = new InvalidConversationCommandError("Declared reason");
		Object.assign(error, { reason: "Incidental field", currentConversation: { id: 1 } });
		expect(presentDomainError(error, { 200: notFoundOutcome, 422: invalidOutcome })).toMatchObject({
			code: 422, response: { outcome: "invalid", reason: "Declared reason" },
		});
		expect(Object.keys(presentDomainError(error, { 422: invalidOutcome }).response)).toEqual(["outcome", "reason"]);
	});

});
