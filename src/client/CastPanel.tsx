import { Pin, Plus, UserPlus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { libraryPickerEntries } from "./cast";
import { presentRemovalOutcome, removalConfirmationCopy } from "./cast-remove";
import {
	presentSaveParticipantOutcome,
	type SavedCharacterReference,
} from "./cast-save";
import { listCharacters, type CharacterSummary } from "./character-library";
import {
	addCharacterToCast,
	applyConversationCommand,
	loadConversation,
	saveParticipantAsCharacter,
	type ConversationSnapshot,
	type ParticipantPrompt,
} from "./conversation";

// Conversation-local Cast drawer: ordered Participants with computed
// duplicate labels, Control badges, Character provenance, and the actions
// currently allowed for each one. Participants are appended from a
// pinned-first alphabetic Character picker (with ordinals, Prompt previews,
// and used-counts) or from an ad-hoc complete Definition. Removing
// Participants is a separate confirmed flow; eligibility is derived by the
// server snapshot and displayed here. Any active Participant with a
// complete Definition can be promoted into a new reusable Character without
// leaving the Chat.

interface CastPanelProps {
	conversationId: number;
	conversation: ConversationSnapshot | null;
	onConversationChange: (conversation: ConversationSnapshot | null) => void;
	// Navigates to a specific Character Library entry, offered after a
	// Participant has been saved as a new Character. The user stays in the
	// Chat until they choose to follow it.
	onOpenLibraryCharacter: (characterId: number) => void;
}

const emptyPrompt = (): ParticipantPrompt => ({
	systemInstruction: "",
	identity: "",
	scenario: "",
	exampleDialogue: "",
	postHistoryInstruction: "",
});

interface AdHocDraft {
	name: string;
	prompt: ParticipantPrompt;
	openingsText: string;
}

const emptyAdHocDraft: AdHocDraft = {
	name: "",
	prompt: emptyPrompt(),
	openingsText: "",
};

const openingsToText = (openings: readonly string[]) => openings.join("\n");

const openingsFromText = (text: string) =>
	text.split("\n").map((line) => line.trimEnd());

const promptFields: Array<{ key: keyof ParticipantPrompt; label: string }> = [
	{ key: "systemInstruction", label: "System Instruction" },
	{ key: "identity", label: "Identity" },
	{ key: "scenario", label: "Scenario" },
	{ key: "exampleDialogue", label: "Example Dialogue" },
	{ key: "postHistoryInstruction", label: "Post-History Instruction" },
];

export function CastPanel({
	conversationId,
	conversation,
	onConversationChange,
	onOpenLibraryCharacter,
}: CastPanelProps) {
	const [characters, setCharacters] = useState<CharacterSummary[] | null>(null);
	const [adding, setAdding] = useState<"library" | "adhoc" | null>(null);
	const [editingParticipantId, setEditingParticipantId] = useState<number | null>(
		null,
	);
	const [notice, setNotice] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	// Identifies the Participant whose removal confirmation dialog is open.
	// The confirmation copy is derived from the snapshot's removal impact
	// (deletion mode and affected-generation count) shown before dispatch.
	const [removeTargetId, setRemoveTargetId] = useState<number | null>(null);
	const [adHocDraft, setAdHocDraft] = useState<AdHocDraft>(emptyAdHocDraft);
	// Announces a completed promotion and the navigation action to the new
	// Character Library entry; cleared when the next save attempt starts so
	// the drawer never shows a stale confirmation next to a fresh failure.
	const [saveConfirmation, setSaveConfirmation] = useState<{
		participantLabel: string;
		character: SavedCharacterReference;
	} | null>(null);

	const loadCharacters = useCallback(async () => {
		try {
			setCharacters(await listCharacters());
		} catch {
			setCharacters([]);
		}
	}, []);

	useEffect(() => {
		void loadCharacters();
	}, [loadCharacters]);

	const refreshConversation = useCallback(async () => {
		try {
			onConversationChange(await loadConversation(conversationId));
		} catch {
			setNotice("The Conversation could not be reached.");
		}
	}, [conversationId, onConversationChange]);

	// Removes one unseated Participant after the confirmation dialog. The
	// impact was already shown from the snapshot; the typed not-removable
	// outcome covers the race where Control changed before the command
	// landed, and the authoritative Cast is reloaded after it.
	const applyRemove = async (participant: {
		id: number;
		duplicateLabel: string;
	}) => {
		if (conversation === null) return;
		setRemoveTargetId(null);
		await runCommand(async () => {
			const outcome = await applyConversationCommand(
				conversationId,
				conversation.revision,
				{ type: "remove-participant", participantId: participant.id },
			);
			const presentation = presentRemovalOutcome(
				outcome,
				participant.duplicateLabel,
			);
			if (presentation.reloadConversation) {
				await refreshConversation();
			}
			if (outcome.status === "applied") {
				onConversationChange(outcome.conversation);
				setNotice(null);
				return { ok: true };
			}
			if (presentation.notice !== null) {
				return { ok: false, message: presentation.notice };
			}
			return { ok: true };
		});
	};

	const pickerEntries = useMemo(
		() => libraryPickerEntries(characters ?? [], conversation?.cast ?? []),
		[characters, conversation],
	);

	if (conversation === null) {
		return (
			<div className="panel-body">
				<p className="panel-intro">Loading the Cast…</p>
			</div>
		);
	}

	const runCommand = async (
		run: () => Promise<{ ok: boolean; message?: string }>,
	) => {
		setPending(true);
		try {
			const outcome = await run();
			if (!outcome.ok && outcome.message) {
				setNotice(outcome.message);
			}
		} finally {
			setPending(false);
		}
	};

	const applyAddCharacter = async (characterId: number, expectedRevision: number) => {
		if (conversation === null) return;
		await runCommand(async () => {
			const outcome = await addCharacterToCast({
				conversationId,
				expectedConversationRevision: conversation.revision,
				characterId,
				expectedCharacterRevision: expectedRevision,
			});
			switch (outcome.status) {
				case "applied":
					onConversationChange(outcome.conversation);
					setNotice(null);
					return { ok: true };
				case "conflict":
					if (outcome.currentConversation !== undefined) {
						onConversationChange(outcome.currentConversation);
						return {
							ok: false,
							message:
								"The Conversation changed elsewhere; the authoritative Cast was reloaded.",
						};
					}
					await refreshConversation();
					return {
						ok: false,
						message: `${outcome.currentCharacterName ?? "The Character"} changed in the Library; the latest Definition was reloaded.`,
					};
				case "not-found":
					await refreshConversation();
					return { ok: false, message: "That Character is no longer available." };
				case "invalid":
					return { ok: false, message: outcome.reason };
				default:
					return { ok: false, message: "The Library could not be reached." };
			}
		});
	};

	const applyAddAdHoc = async () => {
		if (conversation === null) return;
		await runCommand(async () => {
			const outcome = await applyConversationCommand(
				conversationId,
				conversation.revision,
				{
					type: "add-participant",
					definition: {
						name: adHocDraft.name,
						prompt: adHocDraft.prompt,
						openings: openingsFromText(adHocDraft.openingsText),
					},
				},
			);
			switch (outcome.status) {
				case "applied":
					onConversationChange(outcome.conversation);
					setAdHocDraft(emptyAdHocDraft);
					setNotice(null);
					return { ok: true };
				case "conflict":
					onConversationChange(outcome.currentConversation);
					return {
						ok: false,
						message: "The Conversation changed elsewhere; the Cast was reloaded.",
					};
				case "invalid":
					return { ok: false, message: outcome.reason };
				default:
					return { ok: false, message: "The Conversation could not be reached." };
			}
		});
	};

	// Saves one active Participant as a new reusable Character. The command
	// carries only the expected Conversation revision and the Participant
	// reference: the authoritative server-side Definition is copied by the
	// workflow, so a stale client copy can never leak into the Library. The
	// Participant, its provenance, and every local draft stay untouched;
	// on success the drawer offers navigation to the new Library entry.
	const applySaveParticipant = async (participant: {
		id: number;
		duplicateLabel: string;
	}) => {
		if (conversation === null) return;
		setSaveConfirmation(null);
		await runCommand(async () => {
			const outcome = await saveParticipantAsCharacter({
				conversationId,
				expectedConversationRevision: conversation.revision,
				participantId: participant.id,
			});
			const presentation = presentSaveParticipantOutcome(
				outcome,
				participant.duplicateLabel,
			);
			if (presentation.savedCharacter !== null) {
				setSaveConfirmation({
					participantLabel: participant.duplicateLabel,
					character: presentation.savedCharacter,
				});
			}
			if (presentation.reloadConversation) {
				await refreshConversation();
			}
			if (presentation.notice !== null) {
				return { ok: false, message: presentation.notice };
			}
			return { ok: true };
		});
	};

	// Removes the targeted unseated Participant after an explicit confirmation
	// showing the snapshot-derived impact (hard delete versus tombstone and
	// the exact regeneration loss). Success refreshes Control, ordering,
	// history labels, and capabilities from the authoritative snapshot.
	const removeTarget =
		removeTargetId !== null
			? (conversation.cast.find(
					(participant) => participant.id === removeTargetId,
				) ?? null)
			: null;
	const removeConfirmation =
		removeTarget !== null
			? removalConfirmationCopy(removeTarget.duplicateLabel, removeTarget.removal)
			: null;

	return (
		<div className="panel-body">
			<p className="panel-intro">
				Cast members are local to this Chat. The composer's Writing as and
				Responding as selectors assign the two Control seats.
			</p>

			<button
				className="secondary-button library-new-button"
				type="button"
				aria-expanded={adding !== null}
				onClick={() => {
					setAdding(adding !== null ? null : "library");
					setNotice(null);
				}}
			>
				<UserPlus aria-hidden="true" />
				{adding !== null ? "Close add Participant" : "Add Participant"}
			</button>

			{adding !== null && (
				<section className="add-participant">
					<div className="seat-mode" role="tablist" aria-label="Participant source">
						<button
							type="button"
							data-active={adding === "library"}
							onClick={() => {
								setAdding("library");
								setNotice(null);
							}}
							disabled={characters !== null && characters.length === 0}
						>
							From the Library
						</button>
						<button
							type="button"
							data-active={adding === "adhoc"}
							onClick={() => {
								setAdding("adhoc");
								setNotice(null);
							}}
						>
							Ad-hoc Definition
						</button>
					</div>

					{adding === "library" && (
						<>
							<p className="panel-note">
								Pinned Characters come first. Adding a Character forks its
								current Definition; the same Character can be forked again.
							</p>
							{characters !== null && characters.length === 0 ? (
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
													void applyAddCharacter(
														entry.character.id,
														entry.character.revision,
													)
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

					{adding === "adhoc" && (
						<form
							className="definition-form"
							onSubmit={(event) => {
								event.preventDefault();
								void applyAddAdHoc();
							}}
						>
							<div className="field">
								<label htmlFor="cast-adhoc-name">Name</label>
								<input
									id="cast-adhoc-name"
									className="field-input"
									value={adHocDraft.name}
									onChange={(event) =>
										setAdHocDraft((current) => ({
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
										value={adHocDraft.prompt[field.key]}
										onChange={(event) =>
											setAdHocDraft((current) => ({
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
									value={adHocDraft.openingsText}
									onChange={(event) =>
										setAdHocDraft((current) => ({
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
								disabled={pending || adHocDraft.name.trim() === ""}
							>
								Add Participant
							</button>
						</form>
					)}
				</section>
			)}

			{notice !== null && (
				<p className="panel-note" role="status">
					{notice}
				</p>
			)}

			{saveConfirmation !== null && (
				<div className="save-character-confirmation" role="status">
					<p>
						Saved {saveConfirmation.participantLabel} as a new Character,{" "}
						<strong>{saveConfirmation.character.name}</strong>. The Participant stays
						local to this Chat; the Character and Participant are independent.
					</p>
					<button
						className="secondary-button"
						type="button"
						onClick={() => onOpenLibraryCharacter(saveConfirmation.character.id)}
					>
						View in Library
					</button>
				</div>
			)}

			{conversation.cast.length === 0 ? (
				<p className="panel-note">This Conversation has no Cast members yet.</p>
			) : (
				<ul className="cast-list">
					{conversation.cast.map((participant) => {
						const seat =
							participant.id === conversation.control.humanParticipantId
								? "human"
								: participant.id === conversation.control.modelParticipantId
									? "model"
									: null;
						const editing = editingParticipantId === participant.id;
						return (
							<li key={participant.id}>
								<MemberRow
									participant={participant}
									seat={seat}
									editing={editing}
									pending={pending}
									onToggleEdit={() =>
										setEditingParticipantId(editing ? null : participant.id)
									}
									onSaveAsCharacter={() =>
										void applySaveParticipant(participant)
									}
									onRemove={() => setRemoveTargetId(participant.id)}
								/>
								{editing && (
									<ParticipantEditor
										conversationId={conversationId}
										conversation={conversation}
										participantId={participant.id}
										onConversationChange={onConversationChange}
										onNotice={setNotice}
									/>
								)}
							</li>
						);
					})}
				</ul>
			)}

			{removeTarget !== null && removeConfirmation !== null && (
				<Dialog
					open
					onOpenChange={(open) => {
						if (!open) setRemoveTargetId(null);
					}}
				>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>{removeConfirmation.title}</DialogTitle>
							<DialogDescription>{removeConfirmation.impact}</DialogDescription>
						</DialogHeader>
						<DialogFooter>
							<button
								className="secondary-button"
								type="button"
								disabled={pending}
								onClick={() => setRemoveTargetId(null)}
							>
								Cancel
							</button>
							<button
								className="primary-button"
								type="button"
								disabled={pending || removeConfirmation.confirmLabel === "Close"}
								onClick={() => {
									if (removeTarget !== null) {
										void applyRemove(removeTarget);
									}
								}}
							>
								{removeConfirmation.confirmLabel}
							</button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			)}
		</div>
	);
}

function MemberRow({
	participant,
	seat,
	editing,
	pending,
	onToggleEdit,
	onSaveAsCharacter,
	onRemove,
}: {
	participant: {
		duplicateLabel: string;
		sourceCharacterName: string | null;
		removal: {
			eligible: boolean;
			reason: "control-assigned" | null;
			deletionMode: "hard-delete" | "tombstone" | null;
			affectedGenerationCount: number;
		};
	};
	seat: "human" | "model" | null;
	editing: boolean;
	pending: boolean;
	onToggleEdit: () => void;
	onSaveAsCharacter: () => void;
	onRemove: () => void;
}) {
	const provenance =
		participant.sourceCharacterName !== null
			? `Fork of ${participant.sourceCharacterName}`
			: "Ad-hoc Participant";
	const removable = seat === null && participant.removal.eligible;
	const removalNote =
		seat !== null
			? participant.removal.reason === "control-assigned"
				? "Change a Control seat before this Participant can be removed."
				: "Remove availability is confirmed separately."
			: participant.removal.deletionMode === "tombstone"
				? participant.removal.affectedGenerationCount === 1
					? "Removable; 1 Message loses sibling generation."
					: `Removable; ${participant.removal.affectedGenerationCount} Messages lose sibling generation.`
				: "Removable: no history refers to it; removal hard-deletes it.";

	return (
		<div className="cast-member">
			<div className="cast-member-copy">
				<strong>{participant.duplicateLabel}</strong>
				<span>{provenance}</span>
				<span>{removalNote}</span>
			</div>
			<div className="cast-member-right">
				{seat !== null && (
					<span className="control-badge" data-seat={seat}>
						{seat === "human" ? "Human" : "Model"}
					</span>
				)}
				<button
					className="secondary-button cast-edit-button"
					type="button"
					disabled={pending}
					onClick={onToggleEdit}
					aria-expanded={editing}
				>
					{editing ? "Close" : "Edit"}
				</button>
				<button
					className="secondary-button cast-save-button"
					type="button"
					disabled={pending}
					onClick={onSaveAsCharacter}
				>
					Save as Character
				</button>
				{removable && (
					<button
						className="secondary-button cast-remove-button"
						type="button"
						disabled={pending}
						onClick={onRemove}
					>
						Remove
					</button>
				)}
			</div>
		</div>
	);
}

function ParticipantEditor({
	conversationId,
	conversation,
	participantId,
	onConversationChange,
	onNotice,
}: {
	conversationId: number;
	conversation: ConversationSnapshot;
	participantId: number;
	onConversationChange: (conversation: ConversationSnapshot) => void;
	onNotice: (notice: string | null) => void;
}) {
	const participant = conversation.cast.find(
		(candidate) => candidate.id === participantId,
	);
	const [drafts, setDrafts] = useState(() => ({
		name: participant?.name ?? "",
		prompt: participant?.prompt ?? emptyPrompt(),
		openingsText: participant ? openingsToText(participant.openings) : "",
	}));
	const [pending, setPending] = useState(false);

	if (participant === undefined) {
		return <p className="panel-note">This Participant is no longer in the Cast.</p>;
	}

	const apply = async (
		action: Parameters<typeof applyConversationCommand>[2],
		section: "name" | "prompt" | "openings",
	) => {
		setPending(true);
		try {
			const outcome = await applyConversationCommand(
				conversationId,
				conversation.revision,
				action,
			);
			switch (outcome.status) {
				case "applied": {
					const applied = outcome.conversation;
					onConversationChange(applied);
					setDrafts((current) => ({
						name:
							section === "name"
								? applied.cast.find((p) => p.id === participant.id)?.name ??
									current.name
								: current.name,
						prompt:
							section === "prompt"
								? (applied.cast.find((p) => p.id === participant.id)?.prompt ??
									current.prompt)
								: current.prompt,
						openingsText:
							section === "openings"
								? openingsToText(
										applied.cast.find((p) => p.id === participant.id)?.openings ?? [],
									)
								: current.openingsText,
					}));
					onNotice(null);
					break;
				}
				case "conflict": {
					onConversationChange(outcome.currentConversation);
					onNotice("The Conversation changed elsewhere; the current state was loaded.");
					break;
				}
				case "invalid":
					onNotice(outcome.reason);
					break;
				default:
					onNotice("The Conversation could not be reached.");
			}
		} finally {
			setPending(false);
		}
	};

	return (
		<div className="participant-editor">
			<section className="editor-section">
				<h3>Name</h3>
				<div className="apply-row">
					<input
						className="field-input"
						value={drafts.name}
						onChange={(event) =>
							setDrafts((current) => ({ ...current, name: event.target.value }))
						}
						aria-label="Participant name"
					/>
					<button
						className="secondary-button"
						type="button"
						disabled={pending || drafts.name.trim() === ""}
						onClick={() =>
							void apply(
								{
									type: "rename-participant",
									participantId: participant.id,
									name: drafts.name,
								},
								"name",
							)
						}
					>
						Apply Name
					</button>
				</div>
			</section>

			<section className="editor-section">
				<h3>Prompt</h3>
				<div className="definition-form">
					{promptFields.map((field) => (
						<div className="field" key={field.key}>
							<label htmlFor={`participant-prompt-${participant.id}-${field.key}`}>
								{field.label}
							</label>
							<textarea
								id={`participant-prompt-${participant.id}-${field.key}`}
								rows={2}
								value={drafts.prompt[field.key]}
								onChange={(event) =>
									setDrafts((current) => ({
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
					<button
						className="primary-button"
						type="button"
						disabled={pending}
						onClick={() =>
							void apply(
								{
									type: "replace-participant-prompt",
									participantId: participant.id,
									prompt: drafts.prompt,
								},
								"prompt",
							)
						}
					>
						Apply Prompt
					</button>
				</div>
			</section>

			<section className="editor-section">
				<h3>Openings</h3>
				<div className="definition-form">
					<div className="field">
						<label htmlFor={`participant-openings-${participant.id}`}>Openings</label>
						<textarea
							id={`participant-openings-${participant.id}`}
							rows={3}
							value={drafts.openingsText}
							onChange={(event) =>
								setDrafts((current) => ({
									...current,
									openingsText: event.target.value,
								}))
							}
						/>
						<small>One Opening per line. Editing never rewrites history.</small>
					</div>
					<button
						className="primary-button"
						type="button"
						disabled={pending}
						onClick={() =>
							void apply(
								{
									type: "replace-participant-openings",
									participantId: participant.id,
									openings: openingsFromText(drafts.openingsText),
								},
								"openings",
							)
						}
					>
						Apply Openings
					</button>
				</div>
			</section>
		</div>
	);
}