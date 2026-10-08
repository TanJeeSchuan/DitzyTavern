import { promptPresetSelectClass } from "../../prompt-preset-presentation";
import { AppSelect } from "@/components/ui/select";

// @approved
//  One typed preset select: the canonical guard decides which vocabulary entries
// are offered and which change values are accepted, so no caller hand-rolls its own
// narrowing and every select renders with the shared styling.
export function PromptPresetSelect<T extends string>({
	id,
	label,
	value,
	emptyLabel,
	labels,
	isOption,
	disabled,
	onChange,
}: {
	id?: string;
	label?: string;
	value: T | "";
	emptyLabel?: string;
	labels: Record<string, string>;
	isOption: (value: string) => value is T;
	disabled: boolean;
	onChange: (value: T | "") => void;
}) {
	return (
		<AppSelect
			id={id}
			aria-label={label}
			className={promptPresetSelectClass}
			value={value}
			disabled={disabled}
			onValueChange={(next) => {
				onChange(next !== "" && isOption(next) ? next : "");
			}}
			emptyLabel={emptyLabel}
			options={Object.entries(labels)
				.filter(([option]) => isOption(option))
				.map(([option, optionLabel]) => ({ value: option, label: optionLabel }))}
		/>
	);
}
