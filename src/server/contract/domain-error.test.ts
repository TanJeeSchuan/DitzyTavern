import { describe, expect, test } from "bun:test";
import { recoverConversationConflict } from "./domain-error-recovery";
import { presentDomainError } from "./domain-error";
import { InvalidConversationCommandError, StaleConversationRevisionError } from "../conversation";
import { PromptPresetDeletionImpactChangedError } from "../prompt-preset";
import { conversationConflict, generationConflictResponse } from "../../shared/contract/conversation-schema";
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

	test("reports disappearance during stale recovery only when the route declares not-found", () => {
		const stale = new StaleConversationRevisionError(1, 2);
		expect(presentDomainError(stale, { 404: notFoundOutcome, 409: conversationConflict }, recoverConversationConflict(() => undefined))).toMatchObject({ code: 404, response: { outcome: "not-found" } });
		expect(() => presentDomainError(stale, { 409: conversationConflict }, recoverConversationConflict(() => undefined))).toThrow(stale);
	});

	test("generation starts report stale revisions while sibling starts rethrow them", () => {
		const stale = new StaleConversationRevisionError(2, 3);
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
