import { ArrowLeft, Check, Pin, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	applyCommand,
	getCharacter,
	listCharacters,
	type CharacterCommand,
	type CharacterPrompt,
	type CharacterSnapshot,
	type CharacterSummary,
} from "./character-library";

// Dedicated Character Library surface: list, create, detail, semantic Apply
// actions, pinning, computed duplicate ordinals, and conflict recovery.
// Internal identifiers stay behind the transport adapters and are never shown.

interface CharacterLibraryPanelProps {
	// When set (e.g. after a Participant was saved as a Character from the
	// Cast drawer), the panel opens that Character on mount or change and
	// then reports the focus as consumed.
	focusCharacterId?: number | null;
	onFocusConsumed?: () => void;
}

interface Drafts {
	name: string;
	prompt: CharacterPrompt;
	openingsText: string;
}

const emptyPrompt: CharacterPrompt = {
	systemInstruction: "",
	identity: "",
	scenario: "",
	exampleDialogue: "",
	postHistoryInstruction: "",
};

const emptyDrafts: Drafts = {
	name: "",
	prompt: emptyPrompt,
	openingsText: "",
};

const openingsToText = (openings: readonly string[]) => openings.join("\n");

const openingsFromText = (text: string) => text.split("\n");

const draftsOf = (character: CharacterSnapshot): Drafts => ({
	name: character.name,
	prompt: character.prompt,
	openingsText: openingsToText(character.openings),
});

const promptFields: Array<{ key: keyof CharacterPrompt; label: string }> = [
	{ key: "systemInstruction", label: "System Instruction" },
	{ key: "identity", label: "Identity" },
	{ key: "scenario", label: "Scenario" },
	{ key: "exampleDialogue", label: "Example Dialogue" },
	{ key: "postHistoryInstruction", label: "Post-History Instruction" },
];

export function CharacterLibraryPanel({
	focusCharacterId = null,
	onFocusConsumed,
}: CharacterLibraryPanelProps) {
	const [characters, setCharacters] = useState<CharacterSummary[] | null>(null);
	const [selectedId, setSelectedId] = useState<number | null>(null);
	const [snapshot, setSnapshot] = useState<CharacterSnapshot | null>(null);
	const [drafts, setDrafts] = useState<Drafts>(emptyDrafts);
	const [conflict, setConflict] = useState<CharacterSnapshot | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [pendingAction, setPendingAction] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [createDraft, setCreateDraft] = useState<Drafts>(emptyDrafts);

	const loadList = useCallback(async () => {
		try {
			setCharacters(await listCharacters());
			return true;
		} catch {
			setCharacters(null);
			return false;
		}
	}, []);

	useEffect(() => {
		void loadList();
	}, [loadList]);

	// Computed duplicate ordinals follow library order, so each repeated name
	// gets a visible position without exposing identifiers.
	const displayLabels = useMemo(() => {
		if (characters === null) return [];
		const seen = new Map<string, number>();
		return characters.map((character) => {
			const ordinal = (seen.get(character.name) ?? 0) + 1;
			seen.set(character.name, ordinal);
			return ordinal === 1 ? character.name : `${character.name} (${ordinal})`;
		});
	}, [characters]);

	const openCharacter = useCallback(async (characterId: number) => {
		try {
			const loaded = await getCharacter(characterId);
			if (loaded === null) {
				setNotice("That Character is no longer in the Library.");
				return;
			}
			setSelectedId(loaded.id);
			setSnapshot(loaded);
			setDrafts(draftsOf(loaded));
			setConflict(null);
			setNotice(null);
		} catch {
			setNotice("The Library could not be reached.");
		}
	}, []);

	// Follows one-time navigation into a specific Character entry (for
	// example after the Cast drawer saved a Participant as a Character),
	// then reports the focus as consumed so later library visits start at
	// the top-level list. The same entry stays open if a saved Character is
	// refocused while this panel is already showing it.
	useEffect(() => {
		if (focusCharacterId === null) {
			return;
		}
		void openCharacter(focusCharacterId);
		onFocusConsumed?.();
	}, [focusCharacterId, onFocusConsumed, openCharacter]);

	const runCommand = useCallback(
		async (action: string, command: CharacterCommand) => {
			setPendingAction(action);
			try {
				const outcome = await applyCommand(command);
				switch (outcome.status) {
					case "applied": {
						const applied = outcome.character;
						setSnapshot(applied);
						// Only the edited section syncs from the authoritative result;
						// unsaved edits elsewhere stay client-local.
						setDrafts((current) => ({
							name:
								command.type === "rename"
									? applied.name
									: current.name,
							prompt:
								command.type === "replace-prompt"
									? applied.prompt
									: current.prompt,
							openingsText:
								command.type === "replace-openings"
									? openingsToText(applied.openings)
									: current.openingsText,
						}));
						setConflict(null);
						setNotice(null);
						await loadList();
						break;
					}
					case "conflict": {
						setConflict(outcome.currentCharacter);
						setNotice(null);
						break;
					}
					case "not-found": {
						setSelectedId(null);
						setSnapshot(null);
						setNotice("That Character is no longer in the Library.");
						await loadList();
						break;
					}
					case "invalid": {
						setNotice(outcome.reason);
						break;
					}
					default: {
						setNotice("The Library could not be reached.");
					}
				}
			} finally {
				setPendingAction(null);
			}
		},
		[loadList],
	);

	const resolveConflict = useCallback(
		(mode: "keep-draft" | "load-current") => {
			if (conflict === null) return;
			if (mode === "keep-draft") {
				// Keep every draft exactly as typed; only the revision base moves
				// forward so the next Apply is no longer stale.
				setSnapshot(conflict);
			} else {
				setSnapshot(conflict);
				setDrafts(draftsOf(conflict));
			}
			setConflict(null);
		},
		[conflict],
	);

	const submitCreate = useCallback(async () => {
		setPendingAction("create");
		try {
			const outcome = await applyCommand({
				type: "create",
				definition: {
					name: createDraft.name,
					prompt: createDraft.prompt,
					openings: openingsFromText(createDraft.openingsText),
				},
			});
			if (outcome.status === "applied") {
				setCreating(false);
				setCreateDraft(emptyDrafts);
				await loadList();
				await openCharacter(outcome.character.id);
			} else if (outcome.status === "invalid") {
				setNotice(outcome.reason);
			} else if (outcome.status === "network") {
				setNotice("The Library could not be reached.");
			}
		} finally {
			setPendingAction(null);
		}
	}, [createDraft, loadList, openCharacter]);

	if (characters === null) {
		return (
			<div className="panel-body">
				<p className="panel-intro">Loading the Character Library…</p>
			</div>
		);
	}

	if (selectedId !== null && snapshot !== null && snapshot.id === selectedId) {
		return (
			<CharacterEditor
				snapshot={snapshot}
				drafts={drafts}
				conflict={conflict}
				notice={notice}
				pendingAction={pendingAction}
				onDraftChange={setDrafts}
				onBack={() => {
					setSelectedId(null);
					setSnapshot(null);
					setConflict(null);
					setNotice(null);
				}}
				onCommand={runCommand}
				onResolveConflict={resolveConflict}
			/>
		);
	}

	return (
		<div className="panel-body">
			<p className="panel-intro">
				Reusable identities shared across every Chat. Pinned Characters are
				listed first.
			</p>
			<button
				className="secondary-button library-new-button"
				type="button"
				onClick={() => {
					setCreating((current) => !current);
					setNotice(null);
				}}
				aria-expanded={creating}
			>
				<Plus aria-hidden="true" />
				{creating ? "Close new Character" : "New Character"}
			</button>
			{creating && (
				<form
					className="definition-form"
					onSubmit={(event) => {
						event.preventDefault();
						void submitCreate();
					}}
				>
					<NameField
						id="character-new-name"
						value={createDraft.name}
						onChange={(name) =>
							setCreateDraft((current) => ({ ...current, name }))
						}
					/>
					<PromptFields
						prompt={createDraft.prompt}
						onChange={(prompt) =>
							setCreateDraft((current) => ({ ...current, prompt }))
						}
					/>
					<OpeningsField
						value={createDraft.openingsText}
						onChange={(openingsText) =>
							setCreateDraft((current) => ({ ...current, openingsText }))
						}
					/>
					<button className="primary-button" type="submit" disabled={pendingAction === "create"}>
						Create Character
					</button>
				</form>
			)}
			{notice !== null && !creating && (
				<p className="panel-note" role="status">
					{notice}
				</p>
			)}
			{characters.length === 0 ? (
				<p className="panel-note">
					The Library is empty. Create a Character to begin.
				</p>
			) : (
				<ul className="character-list">
					{characters.map((character, index) => (
						<li key={character.id}>
							<button
								className="character-list-item"
								type="button"
								onClick={() => void openCharacter(character.id)}
							>
								<span>{displayLabels[index]}</span>
								{character.pinned && (
									<small aria-label="Pinned">
										<Pin aria-hidden="true" />
									</small>
								)}
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function CharacterEditor({
	snapshot,
	drafts,
	conflict,
	notice,
	pendingAction,
	onDraftChange,
	onBack,
	onCommand,
	onResolveConflict,
}: {
	snapshot: CharacterSnapshot;
	drafts: Drafts;
	conflict: CharacterSnapshot | null;
	notice: string | null;
	pendingAction: string | null;
	onDraftChange: (drafts: Drafts) => void;
	onBack: () => void;
	onCommand: (action: string, command: CharacterCommand) => Promise<void>;
	onResolveConflict: (mode: "keep-draft" | "load-current") => void;
}) {
	return (
		<div className="panel-body">
			<button className="library-back" type="button" onClick={onBack}>
				<ArrowLeft aria-hidden="true" />
				All Characters
			</button>

			{conflict !== null && (
				<div className="conflict-banner" role="alert">
					<p>
						This Character changed elsewhere after you opened it. Your edits
						were not saved and are still here.
					</p>
					<div>
						<button
							className="primary-button"
							type="button"
							onClick={() => onResolveConflict("keep-draft")}
						>
							Keep my edits
						</button>
						<button
							className="secondary-button"
							type="button"
							onClick={() => onResolveConflict("load-current")}
						>
							Load saved version
						</button>
					</div>
				</div>
			)}

			<section className="editor-section">
				<h3>Name</h3>
				<div className="apply-row">
					<input
						className="field-input"
						value={drafts.name}
						onChange={(event) =>
							onDraftChange({ ...drafts, name: event.target.value })
						}
						aria-label="Character name"
					/>
					<button
						className="secondary-button"
						type="button"
						disabled={pendingAction !== null || drafts.name.trim() === ""}
						onClick={() =>
							void onCommand("rename", {
								type: "rename",
								characterId: snapshot.id,
								expectedRevision: snapshot.revision,
								name: drafts.name,
							})
						}
					>
						Apply Name
					</button>
				</div>
			</section>

			<section className="editor-section">
				<h3>Presence</h3>
				<button
					className="secondary-button"
					type="button"
					disabled={pendingAction !== null}
					onClick={() =>
						void onCommand("pin", {
							type: "set-pinned",
							characterId: snapshot.id,
							expectedRevision: snapshot.revision,
							pinned: !snapshot.pinned,
						})
					}
				>
					{snapshot.pinned ? (
						<>
							<Check aria-hidden="true" /> Pinned
						</>
					) : (
						<>
							<Pin aria-hidden="true" /> Pin this Character
						</>
					)}
				</button>
			</section>

			<section className="editor-section">
				<h3>Prompt</h3>
				<div className="definition-form">
					<PromptFields
						prompt={drafts.prompt}
						onChange={(prompt) => onDraftChange({ ...drafts, prompt })}
					/>
					<button
						className="primary-button"
						type="button"
						disabled={pendingAction !== null}
						onClick={() =>
							void onCommand("prompt", {
								type: "replace-prompt",
								characterId: snapshot.id,
								expectedRevision: snapshot.revision,
								prompt: drafts.prompt,
							})
						}
					>
						Apply Prompt
					</button>
				</div>
			</section>

			<section className="editor-section">
				<h3>Openings</h3>
				<div className="definition-form">
					<OpeningsField
						value={drafts.openingsText}
						onChange={(openingsText) =>
							onDraftChange({ ...drafts, openingsText })
						}
					/>
					<button
						className="primary-button"
						type="button"
						disabled={pendingAction !== null}
						onClick={() =>
							void onCommand("openings", {
								type: "replace-openings",
								characterId: snapshot.id,
								expectedRevision: snapshot.revision,
								openings: openingsFromText(drafts.openingsText),
							})
						}
					>
						Apply Openings
					</button>
				</div>
			</section>

			{notice !== null && (
				<p className="panel-note" role="status">
					{notice}
				</p>
			)}
		</div>
	);
}

function NameField({
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

function PromptFields({
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

function OpeningsField({
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