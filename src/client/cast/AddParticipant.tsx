import { Pin, Plus } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import {
	promptFields,
	type AdHocDraft,
} from "./definition";

interface PickerEntry {
	character: {
		id: number;
		revision: number;
		pinned: boolean;
	};
	label: string;
	preview: string;
	usedCount: number;
}

export function AddParticipant({
	mode,
	charactersEmpty,
	pickerEntries,
	pending,
	draft,
	onModeChange,
	onDraftChange,
	onAddCharacter,
	onAddAdHoc,
}: {
	mode: "library" | "adhoc";
	charactersEmpty: boolean;
	pickerEntries: readonly PickerEntry[];
	pending: boolean;
	draft: AdHocDraft;
	onModeChange: (mode: "library" | "adhoc") => void;
	onDraftChange: Dispatch<SetStateAction<AdHocDraft>>;
	onAddCharacter: (characterId: number, revision: number) => void;
	onAddAdHoc: () => void;
	}) {
	return (
		<section className="add-participant">
					<div className="seat-mode" role="tablist" aria-label="Participant source">
						<button
							type="button"
							data-active={mode === "library"}
							onClick={() => {
								onModeChange("library");
							}}
							disabled={charactersEmpty}
						>
							From the Library
						</button>
						<button
							type="button"
							data-active={mode === "adhoc"}
							onClick={() => {
								onModeChange("adhoc");
							}}
						>
							Ad-hoc Definition
						</button>
					</div>

					{mode === "library" && (
						<>
							<p className="panel-note">
								Pinned Characters come first. Adding a Character forks its
								current Definition; the same Character can be forked again.
							</p>
							{charactersEmpty ? (
								<p className="panel-note">
									The Library is empty. Create a Character first.
								</p>
							) : (
								<ul className="character-picker-list">
									{pickerEntries.map((entry) => (
										<li key={entry.character.id}>
											<div className="character-picker-copy">
												<strong>{entry.label}</strong>
												{entry.character.pinned && (
													<Pin aria-hidden="true" className="pinned-mark" />
												)}
												<span className="prompt-preview">{entry.preview}</span>
												<small>
													{entry.usedCount === 0
														? "Not used in this Cast"
														: entry.usedCount === 1
															? "Used once in this Cast"
															: `Used ${entry.usedCount} times in this Cast`}
												</small>
											</div>
											<button
												className="secondary-button"
												type="button"
												disabled={pending}
												onClick={() =>
													onAddCharacter(entry.character.id, entry.character.revision)
												}
											>
												<Plus aria-hidden="true" /> Add
											</button>
										</li>
									))}
								</ul>
							)}
						</>
					)}

					{mode === "adhoc" && (
						<form
							className="definition-form"
							onSubmit={(event) => {
								event.preventDefault();
								onAddAdHoc();
							}}
						>
							<div className="field">
								<label htmlFor="cast-adhoc-name">Name</label>
								<input
									id="cast-adhoc-name"
									className="field-input"
									value={draft.name}
									onChange={(event) =>
										onDraftChange((current) => ({
											...current,
											name: event.target.value,
										}))
									}
									placeholder="A Conversation-local name"
								/>
							</div>
							{promptFields.map((field) => (
								<div className="field" key={field.key}>
									<label htmlFor={`cast-adhoc-${field.key}`}>{field.label}</label>
									<textarea
										id={`cast-adhoc-${field.key}`}
										rows={2}
										value={draft.prompt[field.key]}
										onChange={(event) =>
											onDraftChange((current) => ({
												...current,
												prompt: {
													...current.prompt,
													[field.key]: event.target.value,
												},
											}))
										}
									/>
								</div>
							))}
							<div className="field">
								<label htmlFor="cast-adhoc-openings">Openings</label>
								<textarea
									id="cast-adhoc-openings"
									rows={3}
									value={draft.openingsText}
									onChange={(event) =>
										onDraftChange((current) => ({
											...current,
											openingsText: event.target.value,
										}))
									}
								/>
								<small>One Opening per line. Openings never insert history.</small>
							</div>
							<button
								className="primary-button"
								type="submit"
								disabled={pending || draft.name.trim() === ""}
							>
								Add Participant
							</button>
						</form>
					)}
		</section>
	);
}
