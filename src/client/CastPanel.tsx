import { Pin, Plus, UserPlus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { libraryPickerEntries } from "./cast";
import { listCharacters, type CharacterSummary } from "./character-library";
import {
	addCharacterToCast,
	applyConversationCommand,
	loadConversation,
	type ConversationSnapshot,
	type ParticipantPrompt,
} from "./conversation";

// Conversation-local Cast drawer: ordered Participants with computed
// duplicate labels, Control badges, Character provenance, and the actions
// currently allowed for each one. Participants are appended from a
// pinned-first alphabetic Character picker (with ordinals, Prompt previews,
// and used-counts) or from an ad-hoc complete Definition. Removing
// Participants is a separate confirmed flow; eligibility is derived by the
// server snapshot and displayed here.

interface CastPanelProps {
	conversationId: number;
	conversation: ConversationSnapshot | null;
	onConversationChange: (conversation: ConversationSnapshot | null) => void;
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
}: CastPanelProps) {
	const [characters, setCharacters] = useState<CharacterSummary[] | null>(null);
	const [adding, setAdding] = useState<"library" | "adhoc" | null>(null);
	const [editingParticipantId, setEditingParticipantId] = useState<number | null>(
		null,
	);
	const [notice, setNotice] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [adHocDraft, setAdHocDraft] = useState<AdHocDraft>(emptyAdHocDraft);

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
		</div>
	);
}

function MemberRow({
	participant,
	seat,
	editing,
	pending,
	onToggleEdit,
}: {
	participant: {
		duplicateLabel: string;
		sourceCharacterName: string | null;
		removal: { eligible: boolean; reason: "control-assigned" | null };
	};
	seat: "human" | "model" | null;
	editing: boolean;
	pending: boolean;
	onToggleEdit: () => void;
}) {
	const provenance =
		participant.sourceCharacterName !== null
			? `Fork of ${participant.sourceCharacterName}`
			: "Ad-hoc Participant";
	const removalNote =
		seat !== null
			? participant.removal.reason === "control-assigned"
				? "Change a Control seat before this Participant can be removed."
				: "Remove availability is confirmed separately."
			: "Unseated — eligible for removal.";

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