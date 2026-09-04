import type { ChatImportFlowState } from "../import-chat-flow";

// ==[HUMAN APPROVED]== The related-import notice and the warnings list read identically at
// every step that shows them, so both steps and the receipt render the one
// component rather than repeating its copy.
export function ImportRelatedNotice({
	related,
}: {
	related: ChatImportFlowState["duplicates"]["related"];
}) {
	if (related.length === 0) return null;
	return (
		<p className="import-related-banner">
			<span>
				A related import was found in{" "}
				{related.map((match) => `Chat ${match.id}`).join(", ")}. Both files
				report the same integrity value, but their bytes differ.
			</span>
		</p>
	);
}

export function ImportWarningsList({
	warnings,
}: {
	warnings: readonly string[];
}) {
	if (warnings.length === 0) return null;
	return (
		<section className="import-warnings">
			<h3>Warnings</h3>
			<ul>
				{warnings.map((warning) => (
					<li key={warning}>{warning}</li>
				))}
			</ul>
		</section>
	);
}

// ==[HUMAN APPROVED]== The Chat title is editable at both the resolution and review steps; the
// placeholder is the only difference the steps ever needed.
export function ImportTitleField({
	title,
	placeholder,
	onTitleChange,
}: {
	title: string;
	placeholder?: string;
	onTitleChange: (title: string) => void;
}) {
	return (
		<label className="seat-field">
			<span>Chat title</span>
			<input
				value={title}
				placeholder={placeholder}
				onChange={(event) => onTitleChange(event.target.value)}
			/>
		</label>
	);
}
