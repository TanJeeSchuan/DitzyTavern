import { describe, expect, test } from "bun:test";
import { presentDomainError } from "./domain-error";
import { InvalidConversationCommandError } from "../conversation";
import { StaleRevisionError } from "../revision";
import { PromptPresetDeletionImpactChangedError } from "../prompt-preset";
import { generationConflictResponse } from "../../shared/contract/conversation-schema";
import { modelSelectionConflict } from "../../shared/contract/model-selection";
import { promptPresetCommandResponse } from "../../shared/contract/prompt-preset";
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

	test("presents the same stale-revision envelope for settings and presets", () => {
		const settings = { profileId: 1, model: "Writer", revision: 3 };
		const preset = { id: 9, name: "Changed", revision: 3, isBuiltIn: false, conversationCount: 1 };
		const settingsConflict = presentDomainError(new StaleRevisionError("settings", 2, 3, settings), { 409: modelSelectionConflict });
		const presetConflict = presentDomainError(new StaleRevisionError("preset", 2, 3, preset), promptPresetCommandResponse);
		const conflict = { outcome: "conflict", reason: "stale-revision", expectedRevision: 2, actualRevision: 3 } as const;

		expect(settingsConflict.code).toBe(409);
		expect(settingsConflict.response).toEqual({ ...conflict, current: settings });
		expect(presetConflict.code).toBe(409);
		expect(presetConflict.response).toEqual({ ...conflict, current: preset });
	});

	test("presents a nested deletion-impact union with its authoritative preset", () => {
		const preset = { id: 9, name: "Changed", revision: 2, isBuiltIn: false, conversationCount: 3 };
		const error = new PromptPresetDeletionImpactChangedError(1, preset);
		const result = presentDomainError(error, promptPresetCommandResponse);
		expect(result.code).toBe(409);
		expect(result.response).toEqual({ outcome: "conflict", reason: "deletion-impact", current: preset });
	});

	test("generation starts report stale revisions as prose while undeclared envelopes rethrow", () => {
		const stale = new StaleRevisionError("generation", 2, 3);
		const result = presentDomainError(stale, { 409: generationConflictResponse });
		expect(result.code).toBe(409);
		expect(result.response).toEqual({ outcome: "conflict", reason: stale.message });
		expect(() => presentDomainError(stale, { 409: notPlayableOutcome })).toThrow(stale);
	});

	test("only declared details enter the payload", () => {
		const error = new InvalidConversationCommandError("Declared reason");
		Object.assign(error, { reason: "Incidental field", current: { id: 1 } });
		expect(presentDomainError(error, { 200: notFoundOutcome, 422: invalidOutcome })).toMatchObject({
			code: 422, response: { outcome: "invalid", reason: "Declared reason" },
		});
		expect(Object.keys(presentDomainError(error, { 422: invalidOutcome }).response)).toEqual(["outcome", "reason"]);
	});

});
