import { sharedConnectionProfileValidationError } from "../shared/connection-profile-validation";
import type { ConnectionProfileDraft } from "./connection-settings";
import type { HeaderEditorData } from "./connection-settings-state";

export function connectionDraftValidationError(
	draft: ConnectionProfileDraft,
	headerEditorData: HeaderEditorData,
): string | null {
	return connectionBasicDraftValidationError(draft) ?? connectionAdvancedDraftValidationError(draft, headerEditorData);
}

export function connectionBasicDraftValidationError(
	draft: ConnectionProfileDraft,
): string | null {
	if (draft.displayName.trim().length === 0) {
		return "A Connection Profile display name is required.";
	}
	if (draft.pinnedModels.some((model) => model.trim().length === 0)) {
		return "Pinned model IDs cannot be blank.";
	}
	return null;
}

export function connectionAdvancedDraftValidationError(
	draft: ConnectionProfileDraft,
	headerEditorData: HeaderEditorData,
): string | null {
	return sharedConnectionProfileValidationError(draft, Object.keys(headerEditorData));
}
