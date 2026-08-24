import type { CharacterPrompt } from "../character-library";
import { promptFields } from "./definition";

export function NameField({
	id,
	value,
	onChange,
}: {
	id: string;
	value: string;
	onChange: (value: string) => void;
}) {
	return (
		<div className="field">
			<label htmlFor={id}>Name</label>
			<input
				id={id}
				className="field-input"
				value={value}
				onChange={(event) => onChange(event.target.value)}
				placeholder="A reusable name, such as Maren Voss"
			/>
		</div>
	);
}

export function PromptFields({
	prompt,
	onChange,
}: {
	prompt: CharacterPrompt;
	onChange: (prompt: CharacterPrompt) => void;
}) {
	return (
		<>
			{promptFields.map((field) => (
				<PromptField
					key={field.key}
					id={`prompt-${field.key}`}
					label={field.label}
					value={prompt[field.key]}
					onChange={(value) => onChange({ ...prompt, [field.key]: value })}
				/>
			))}
		</>
	);
}

function PromptField({
	id,
	label,
	value,
	onChange,
}: {
	id: string;
	label: string;
	value: string;
	onChange: (value: string) => void;
}) {
	return (
		<div className="field">
			<label htmlFor={id}>{label}</label>
			<textarea
				id={id}
				rows={2}
				value={value}
				onChange={(event) => onChange(event.target.value)}
			/>
		</div>
	);
}

export function OpeningsField({
	value,
	onChange,
}: {
	value: string;
	onChange: (value: string) => void;
}) {
	return (
		<div className="field">
			<label htmlFor="character-openings">Openings</label>
			<textarea
				id="character-openings"
				rows={4}
				value={value}
				onChange={(event) => onChange(event.target.value)}
			/>
			<small>One Opening per line, shown in order.</small>
		</div>
	);
}

