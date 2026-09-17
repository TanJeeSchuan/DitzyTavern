import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	applyLorebookAttachmentCommand,
	getCharacterLorebookAttachments,
	getParticipantLorebookAttachments,
	listLorebooks,
	type LoreAttachmentCommand,
	type LorebookOwnerAttachmentState,
} from "../lorebook-library";

type Owner = "character" | "participant";

const ownerLabel = (owner: Owner): string => owner === "character" ? "Character" : "Participant";

export function LoreAttachmentEditor({ owner, ownerId, disabled = false }: { owner: Owner; ownerId: number; disabled?: boolean }) {
	const [state, setState] = useState<LorebookOwnerAttachmentState | null>(null);
	const [books, setBooks] = useState<Awaited<ReturnType<typeof listLorebooks>>>([]);
	const [selectedBookId, setSelectedBookId] = useState("");
	const [selectedScope, setSelectedScope] = useState<"controlled-participant" | "cast">("cast");
	const [pending, setPending] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		void Promise.all([
			listLorebooks(),
			owner === "character" ? getCharacterLorebookAttachments(ownerId) : getParticipantLorebookAttachments(ownerId),
		]).then(([loadedBooks, loadedState]) => {
			if (cancelled) return;
			setBooks(loadedBooks);
			setState(loadedState);
		}).catch(() => { if (!cancelled) setNotice("Lorebook attachments could not be loaded."); });
		return () => { cancelled = true; };
	}, [owner, ownerId]);

	const bookNames = useMemo(() => new Map(books.map((book) => [book.id, book.name])), [books]);
	const send = async (command: LoreAttachmentCommand) => {
		setPending(true);
		setNotice(null);
		try {
			await applyLorebookAttachmentCommand(command);
			const refreshed = owner === "character" ? await getCharacterLorebookAttachments(ownerId) : await getParticipantLorebookAttachments(ownerId);
			setState(refreshed);
		} catch { setNotice("Lorebook attachment could not be saved."); }
		finally { setPending(false); }
	};

	if (state === null) return <LoreAttachmentLoading owner={owner} />;

	const attach = () => {
		const bookId = Number(selectedBookId);
		if (!Number.isInteger(bookId)) return;
		void send(owner === "character"
			? { type: "attach-character", characterId: ownerId, bookId, scope: selectedScope }
			: { type: "attach-participant", participantId: ownerId, bookId, scope: selectedScope });
	};
	const detach = (bookId: number) => void send(owner === "character"
		? { type: "detach-character", characterId: ownerId, bookId }
		: { type: "detach-participant", participantId: ownerId, bookId });
	const toggle = (attachment: LorebookOwnerAttachmentState["attachments"][number]) => void send(owner === "character"
		? { type: "attach-character", characterId: ownerId, bookId: attachment.bookId, scope: attachment.scope, enabled: !attachment.enabled }
		: { type: "attach-participant", participantId: ownerId, bookId: attachment.bookId, scope: attachment.scope, enabled: !attachment.enabled });

	return <section className="editor-section" aria-label={`${ownerLabel(owner)} Lorebooks`}>
		<h3>Lorebooks</h3>
		<p className="panel-note">Attach shared books to this {ownerLabel(owner)}. Scope controls when the book can activate.</p>
		<div className="apply-row">
			<select className="field-input" value={selectedBookId} disabled={disabled || pending || books.length === 0} onChange={(event) => setSelectedBookId(event.target.value)} aria-label="Lorebook to attach">
				<option value="">Select a Lorebook</option>
				{books.map((book) => <option key={book.id} value={book.id}>{book.name}</option>)}
			</select>
			<select className="field-input" value={selectedScope} disabled={disabled || pending} onChange={(event) => setSelectedScope(event.target.value === "controlled-participant" ? "controlled-participant" : "cast")} aria-label="Lorebook attachment scope">
				<option value="cast">Cast</option>
				<option value="controlled-participant">Controlled Participant</option>
			</select>
			<Button variant="outline" size="sm" type="button" disabled={disabled || pending || selectedBookId === ""} onClick={attach}>Attach</Button>
		</div>
		{state.attachments.length === 0 ? <p className="panel-note">No Lorebooks attached.</p> : <ul className="lore-attachment-list">{state.attachments.map((attachment) => <li className="apply-row" key={attachment.id}><span>{bookNames.get(attachment.bookId) ?? `Book ${attachment.bookId}`} · {attachment.scope} · {attachment.enabled ? "Enabled" : "Disabled"}</span><Button variant="outline" size="sm" type="button" disabled={disabled || pending} onClick={() => toggle(attachment)}>{attachment.enabled ? "Disable" : "Enable"}</Button><Button variant="outline" size="sm" type="button" disabled={disabled || pending} onClick={() => detach(attachment.bookId)}>Detach</Button></li>)}</ul>}
		{notice !== null && <p className="panel-note" role="status">{notice}</p>}
	</section>;
}

function LoreAttachmentLoading({ owner }: { owner: Owner }) {
	return <section className="editor-section" aria-label={`${ownerLabel(owner)} Lorebooks`} aria-busy="true">
		<h3>Lorebooks</h3>
		<p className="sr-only" role="status">Loading Lorebook attachments…</p>
		<p className="panel-note">Attach shared books to this {ownerLabel(owner)}. Scope controls when the book can activate.</p>
		<div className="apply-row">
			<div className="h-9 min-w-40 flex-1 animate-pulse rounded-md bg-muted/50" />
			<div className="h-9 min-w-40 animate-pulse rounded-md bg-muted/50" />
			<div className="h-9 w-16 animate-pulse rounded-md bg-muted/50" />
		</div>
		<ul className="lore-attachment-list" aria-hidden="true">{["first", "second"].map((key) => <li className="apply-row" key={key}><div className="h-5 flex-1 animate-pulse rounded bg-muted/50" /><div className="h-9 w-20 animate-pulse rounded-md bg-muted/50" /><div className="h-9 w-20 animate-pulse rounded-md bg-muted/50" /></li>)}</ul>
	</section>;
}
