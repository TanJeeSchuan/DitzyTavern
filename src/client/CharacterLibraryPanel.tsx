import { Pin, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	applyCommand,
	getCharacter,
	listCharacters,
	type CharacterCommand,
	type CharacterSnapshot,
	type CharacterSummary,
} from "./character-library";
import {
	deletionResultNotice,
	usedCountLabel,
} from "./character-delete";
import { CharacterEditor } from "./character-library/CharacterEditor";
import {
	NameField,
	OpeningsField,
	PromptFields,
} from "./character-library/DefinitionFields";
import {
	draftsOf,
	emptyDrafts,
	openingsFromText,
	openingsToText,
	type Drafts,
} from "./character-library/definition";
import { LIBRARY_UNREACHABLE_NOTICE } from "./lib/command-outcome";
import { useAsyncEffect } from "./lib/use-async";

// ==[HUMAN APPROVED]== The library handles listing, creation, editing, pinning, deletion, and
// conflict recovery. Duplicate names use computed ordinals; database
// identifiers stay out of the UI.

interface CharacterLibraryPanelProps {
	// ==[HUMAN APPROVED]== When set (e.g. after a Participant was saved as a Character from the
	// Cast drawer), the panel opens that Character on mount or change and
	// then reports the focus as consumed.
	focusCharacterId?: number | null;
	onFocusConsumed?: () => void;
}

export function CharacterLibraryPanel({
	focusCharacterId = null,
	onFocusConsumed,
}: CharacterLibraryPanelProps) {
	const [characters, setCharacters] = useState<CharacterSummary[] | null>(null);
	const [selectedId, setSelectedId] = useState<number | null>(null);
	const [snapshot, setSnapshot] = useState<CharacterSnapshot | null>(null);
	const [drafts, setDrafts] = useState<Drafts>(emptyDrafts);
	const draftsRef = useRef(drafts);
	draftsRef.current = drafts;
	const [conflict, setConflict] = useState<CharacterSnapshot | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [pendingAction, setPendingAction] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [createDraft, setCreateDraft] = useState<Drafts>(emptyDrafts);

	const loadList = useCallback(async (isCancelled?: () => boolean) => {
		try {
			const loaded = await listCharacters();
			if (isCancelled?.()) return false;
			setCharacters(loaded);
			return true;
		} catch {
			if (isCancelled?.()) return false;
			setCharacters(null);
			return false;
		}
	}, []);

	useAsyncEffect((isCancelled) => {
		void loadList(isCancelled);
	}, [loadList]);

	// ==[HUMAN APPROVED]== Computed duplicate ordinals follow library order, so each repeated name
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
			setNotice(LIBRARY_UNREACHABLE_NOTICE);
		}
	}, []);

	// ==[HUMAN APPROVED]== Follows one-time navigation into a specific Character entry (for
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
			const submittedDrafts = draftsRef.current;
			setPendingAction(action);
			try {
				const outcome = await applyCommand(command);
				switch (outcome.status) {
					case "applied": {
						const applied = outcome.character;
						setSnapshot(applied);
						// ==[HUMAN APPROVED]== Only the edited section syncs from the authoritative result;
						// unsaved edits elsewhere stay client-local.
						setDrafts((current) => ({
							name:
								command.type === "rename" || command.type === "update-definition"
									? command.type === "update-definition" && current.name !== command.definition.name ? current.name : applied.name
									: current.name,
							prompt:
								command.type === "replace-prompt" || command.type === "update-definition"
									? command.type === "update-definition" && JSON.stringify(current.prompt) !== JSON.stringify(command.definition.prompt) ? current.prompt : applied.prompt
									: current.prompt,
							openingsText:
								command.type === "replace-openings" || command.type === "update-definition"
									? command.type === "update-definition" && JSON.stringify(openingsFromText(current.openingsText)) !== JSON.stringify(command.definition.openings) ? current.openingsText : openingsToText(applied.openings)
									: current.openingsText,
						}));
						setConflict(null);
						setNotice(null);
						await loadList();
						break;
					}
					case "deleted": {
						// ==[HUMAN APPROVED]== The Character (hard-deleted or tombstoned) is no longer
						// readable; return to the top-level list and report the
						// confirmed outcome. Existing Chat Participants were
						// deliberately left untouched by the server command.
						setSelectedId(null);
						setSnapshot(null);
						setDrafts(emptyDrafts);
						setConflict(null);
						setNotice(deletionResultNotice(outcome.result));
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
						setNotice(LIBRARY_UNREACHABLE_NOTICE);
					}
					}
					return outcome.status === "applied" && draftsRef.current === submittedDrafts;
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
				// ==[HUMAN APPROVED]== Keep every draft exactly as typed; only the revision base moves
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
				setNotice(LIBRARY_UNREACHABLE_NOTICE);
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
				onDraftChange={(value) => { draftsRef.current = value; setDrafts(value); }}
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
								title={character.preview}
							>
								<span>{displayLabels[index]}</span>
								<small aria-label={`Used ${usedCountLabel(character.provenanceReferenceCount)}`}>
									{character.pinned && (
										<span aria-label="Pinned" title="Pinned">
											<Pin aria-hidden="true" />{" "}
										</span>
									)}
									{usedCountLabel(character.provenanceReferenceCount)}
								</small>
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
