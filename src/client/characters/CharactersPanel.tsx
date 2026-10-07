import { Check, Pin, Plus, Search, Sparkles, UserRound } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { libraryPickerEntries } from "../cast";
import { removalConfirmationCopy } from "../cast-remove";
import { applyCommand, listCharacters, type CharacterSummary } from "../character-library";
import type { ConversationSummary } from "../conversation";
import { LIBRARY_UNREACHABLE_NOTICE } from "../lib/notices";
import { emptyPromptChannels, promptPreview } from "../../shared/definition";
import { Portrait } from "../story/Portrait";
import { AddParticipantMenu } from "./AddParticipantMenu";
import { CharacterEditor } from "./CharacterEditor";
import { ParticipantEditor } from "./ParticipantEditor";
import { ParticipantMenu, type Seat } from "./ParticipantMenu";
import { useCastActions } from "./useCastActions";

type View =
	| { kind: "list" }
	| { kind: "participant"; id: number; fresh: boolean }
	| { kind: "character"; id: number; fresh: boolean };

type CastParticipant = ConversationSummary["cast"][number];

const provenance = (participant: CastParticipant) =>
	participant.sourceCharacterName === null ? "Chat only"
	: participant.sourceCharacterName === participant.name ? "From the Library"
	: `From ${participant.sourceCharacterName}`;

export function CharactersPanel({
	conversation,
	onConversationChange,
}: {
	conversation: ConversationSummary | null;
	onConversationChange: (conversation: ConversationSummary | null) => void;
}) {
	const [view, setView] = useState<View>({ kind: "list" });
	const [characters, setCharacters] = useState<CharacterSummary[] | null>(null);
	const [query, setQuery] = useState("");
	const [libraryNotice, setLibraryNotice] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [removeTargetId, setRemoveTargetId] = useState<number | null>(null);
	const conversationId = conversation?.id ?? 0;
	const cast = useMemo(() => conversation?.cast ?? [], [conversation]);

	const castActions = useCastActions({ conversationId, conversation, onConversationChange, setRemoveTargetId });

	const loadCharacters = useCallback(() => {
		void listCharacters().then(setCharacters, () => { setCharacters([]); setLibraryNotice(LIBRARY_UNREACHABLE_NOTICE); });
	}, []);
	useEffect(loadCharacters, [loadCharacters]);

	const pickerEntries = useMemo(() => libraryPickerEntries(characters ?? [], cast), [characters, cast]);
	const needle = query.trim().toLocaleLowerCase();
	const libraryRows = pickerEntries.filter((entry) => needle === "" || `${entry.label} ${entry.preview}`.toLocaleLowerCase().includes(needle));
	const seatOf = (id: number): Seat => id === conversation?.control.humanParticipantId ? "human" : id === conversation?.control.modelParticipantId ? "model" : null;
	const openList = () => setView({ kind: "list" });

	const addBlank = async (name: string) => {
		const id = await castActions.applyAddBlank(name);
		if (id !== null) setView({ kind: "participant", id, fresh: true });
	};

	const createCharacter = async () => {
		setCreating(true);
		const outcome = await applyCommand({ type: "create", definition: { name: "New Character", prompt: emptyPromptChannels(), openings: [] } });
		setCreating(false);
		if (outcome.outcome !== "available" || "result" in outcome.value) return setLibraryNotice(outcome.outcome === "invalid" ? outcome.reason : LIBRARY_UNREACHABLE_NOTICE);
		setLibraryNotice(null);
		loadCharacters();
		setView({ kind: "character", id: outcome.value.character.id, fresh: true });
	};

	const menuFor = (participant: CastParticipant, className?: string) => (
		<ParticipantMenu
			name={participant.duplicateLabel}
			seat={seatOf(participant.id)}
			pending={castActions.pending}
			className={className}
			onAssignSeat={(seat) => void castActions.applyAssignSeat(seat, participant.id)}
			onSaveAsCharacter={() => void castActions.applySaveParticipant(participant).then(loadCharacters)}
			onRemove={() => setRemoveTargetId(participant.id)}
		/>
	);

	const removeTarget = cast.find((participant) => participant.id === removeTargetId) ?? null;
	const removeCopy = removeTarget === null ? null : removalConfirmationCopy(removeTarget.duplicateLabel, removeTarget.removal);
	const removeDialog = (
		<Dialog open={removeTarget !== null} onOpenChange={(open) => { if (!open) setRemoveTargetId(null); }}>
			<DialogContent showCloseButton={false} className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>{removeCopy?.title}</DialogTitle>
					<DialogDescription>{removeCopy?.impact}</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button type="button" variant="ghost" disabled={castActions.pending} onClick={() => setRemoveTargetId(null)}>Cancel</Button>
					{removeCopy?.confirmLabel !== "Close" && (
						<Button
							type="button"
							variant="destructive"
							disabled={castActions.pending}
							onClick={() => {
								if (removeTarget !== null) {
									void castActions.applyRemove(removeTarget).then(openList);
								}
							}}
						>
							{removeCopy?.confirmLabel}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);

	if (conversation === null) return <p className="panel-body text-sm text-muted-foreground" role="status">Loading the Cast…</p>;

	if (view.kind === "participant") {
		const participant = cast.find((candidate) => candidate.id === view.id);
		const seat = seatOf(view.id);
		return <>
			<ParticipantEditor
				key={view.id}
				conversation={conversation}
				participantId={view.id}
				autoSelectName={view.fresh}
				subtitle={<>{seat !== null && <><SeatLabel seat={seat} /> · </>}{participant ? provenance(participant) : ""} · Changes stay in this Chat</>}
				actions={participant && menuFor(participant)}
				onConversationChange={onConversationChange}
				onBack={openList}
			/>
			{removeDialog}
		</>;
	}

	if (view.kind === "character") {
		return <CharacterEditor
			key={view.id}
			characterId={view.id}
			autoSelectName={view.fresh}
			canAddToChat={!castActions.pending}
			onAddToChat={(character) => void castActions.applyAddCharacter(character.id, character.revision)}
			onChanged={loadCharacters}
			onClosed={(notice) => { setLibraryNotice(notice); openList(); }}
		/>;
	}

	return (
		<div className="panel-body flex flex-col gap-7">
			<section className="flex flex-col gap-3" aria-labelledby="cast-title">
				<div className="flex items-center justify-between gap-2">
					<h2 id="cast-title" className="text-sm font-semibold">In this chat</h2>
					<AddParticipantMenu
						entries={pickerEntries}
						pending={castActions.pending}
						onAddCharacter={(id, revision) => void castActions.applyAddCharacter(id, revision)}
						onAddBlank={(name) => void addBlank(name)}
					/>
				</div>
				{castActions.notice !== null && <p role="status" className="text-sm text-muted-foreground">{castActions.notice}</p>}
				{castActions.saveConfirmation !== null && (
					<div role="status" className="flex items-center gap-3 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
						<p className="flex-1">Saved {castActions.saveConfirmation.participantLabel} to the Library as <strong className="text-foreground">{castActions.saveConfirmation.character.name}</strong>.</p>
						<Button
							type="button"
							size="xs"
							variant="outline"
							onClick={() => {
								const { id } = castActions.saveConfirmation!.character;
								castActions.setSaveConfirmation(null);
								setView({ kind: "character", id, fresh: false });
							}}
							>
								Open
							</Button>
					</div>
				)}
				{cast.length === 0
					? <p className="text-sm text-muted-foreground">No one is in this Chat yet. Add a Character from the Library below.</p>
					: <ul className="-mx-3 flex flex-col gap-0.5">{cast.map((participant) => {
						const seat = seatOf(participant.id);
						const preview = promptPreview(participant.prompt.identity);
						return (
							<li key={participant.id} className="group relative flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-muted/40 focus-within:bg-muted/40">
								<Portrait name={participant.name} portrait={participant.portrait} size="medium" />
								<button
								type="button"
								className="min-w-0 flex-1 text-left outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-3 focus-visible:after:ring-ring/50"
								onClick={() => setView({ kind: "participant", id: participant.id, fresh: false })}
								>
									<span className="block truncate text-[0.9rem] font-semibold tracking-[-0.01em]">{participant.duplicateLabel}</span>
									{(seat !== null || preview !== "") && (
										<span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
											{seat !== null && <span className="shrink-0"><SeatLabel seat={seat} /></span>}
											{seat !== null && preview !== "" && " · "}
											{preview !== "" && <span className="truncate">{preview}</span>}
										</span>
										)}
								</button>
								{menuFor(participant, "relative z-10 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 aria-expanded:opacity-100 pointer-coarse:opacity-100")}
							</li>
						);
					})}</ul>}
			</section>

			<section className="flex flex-col gap-3 border-t border-border pt-6" aria-labelledby="character-library-title">
				<div className="flex items-center justify-between gap-2">
					<h2 id="character-library-title" className="text-sm font-semibold">Library</h2>
					<Button type="button" size="sm" disabled={creating} onClick={() => void createCharacter()}><Plus aria-hidden="true" /> New</Button>
				</div>
				<label className="search-field">
					<Search aria-hidden="true" />
					<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Characters" aria-label="Search Characters" />
				</label>
				{libraryNotice !== null && <p role="status" className="text-sm text-muted-foreground">{libraryNotice}</p>}
				<ul className="-mx-3 flex flex-col gap-0.5" aria-label="Character Library" aria-busy={characters === null}>
					{characters === null ? <li className="px-3 py-3 text-sm text-muted-foreground">Loading the Library…</li>
					: libraryRows.length === 0 ? (
						<li className="px-3 py-3 text-sm text-muted-foreground">
							{characters.length === 0
								? "No Characters yet. Create one to reuse it across Chats."
								: "No Characters match this search."}
						</li>
						)
					: libraryRows.map((entry) => (
						<li key={entry.character.id} className="group relative flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-muted/40 focus-within:bg-muted/40">
							<Portrait name={entry.label} portrait={entry.character.portrait} size="medium" />
							<button
								type="button"
								className="min-w-0 flex-1 text-left outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-3 focus-visible:after:ring-ring/50"
								onClick={() => setView({ kind: "character", id: entry.character.id, fresh: false })}
								>
								<span className="flex items-center gap-1.5 truncate text-[0.9rem] font-semibold tracking-[-0.01em]">
								{entry.label}
								{entry.character.pinned && <Pin aria-label="Pinned" className="size-3 shrink-0 fill-current text-muted-foreground" />}
							</span>
								{entry.preview !== "" && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{entry.preview}</span>}
							</button>
							{entry.usedCount > 0
								? <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"><Check className="size-3.5" aria-hidden="true" /> In chat</span>
								: (
								<span className="relative z-10 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100">
									<Button
										type="button"
										size="xs"
										variant="ghost"
										disabled={castActions.pending}
										aria-label={`Add ${entry.label} to this Chat`}
										onClick={() => void castActions.applyAddCharacter(entry.character.id, entry.character.revision)}
										>
											<Plus aria-hidden="true" /> Add
										</Button>
								</span>
								)}
						</li>
					))}
				</ul>
			</section>
			{removeDialog}
		</div>
	);
}

function SeatLabel({ seat }: { seat: "human" | "model" }) {
	return seat === "human"
		? <span className="inline-flex items-center gap-1 font-medium text-foreground"><UserRound className="size-3" aria-hidden="true" /> Writing as</span>
		: <span className="inline-flex items-center gap-1 font-medium text-foreground"><Sparkles className="size-3" aria-hidden="true" /> Replying</span>;
}
