import type { GenerationFormattingContext } from "../../shared/contract/conversation-schema";

export type FormattingContext = Pick<
	Required<GenerationFormattingContext>,
	"timeZone" | "locale"
>;

export const clientFormattingContext = (
	overrides: Partial<FormattingContext> = {},
): FormattingContext => {
	const resolved = Intl.DateTimeFormat().resolvedOptions();
	return {
		timeZone: overrides.timeZone ?? resolved.timeZone,
		locale: overrides.locale ?? resolved.locale,
	};
};
