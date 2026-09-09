import { promptPresetSelectClass } from "../../prompt-preset-presentation";

// ==[HUMAN APPROVED]== One typed preset select: the canonical guard decides which vocabulary entries
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
		<select
			id={id}
			aria-label={label}
			className={promptPresetSelectClass}
			value={value}
			disabled={disabled}
			onChange={(event) => {
				const next = event.target.value;
				onChange(next !== "" && isOption(next) ? next : "");
			}}
		>
			{emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
			{Object.entries(labels)
				.filter(([option]) => isOption(option))
				.map(([option, optionLabel]) => (
					<option key={option} value={option}>{optionLabel}</option>
				))}
		</select>
	);
}
