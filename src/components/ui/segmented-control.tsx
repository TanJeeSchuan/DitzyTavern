import type { ReactNode } from "react";
import { RadioGroup } from "radix-ui";

export function SegmentedControl<Value extends string>({ value, onValueChange, options, label, disabled = false }: {
	value: Value;
	onValueChange: (value: Value) => void;
	options: readonly { value: Value; label: ReactNode; disabled?: boolean }[];
	label: string;
	disabled?: boolean;
}) {
	return <RadioGroup.Root className="segmented-control" value={value} onValueChange={(next) => {
		const option = options.find((item) => item.value === next);
		if (option) onValueChange(option.value);
	}} aria-label={label} disabled={disabled} orientation="horizontal">
		{options.map((option) => <RadioGroup.Item key={option.value} value={option.value} disabled={option.disabled} className="segmented-control-item">{option.label}</RadioGroup.Item>)}
	</RadioGroup.Root>;
}
