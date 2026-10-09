import type { LorebookSummary } from "../../shared/contract/lorebook";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { AppSelect } from "@/components/ui/select";
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
	const [books, setBooks] = useState<LorebookSummary[]>([]);
	const [selectedBookId, setSelectedBookId] = useState("");
	const [selectedScope, setSelectedScope] = useState<"controlled-participant" | "cast">("cast");
	const [pending, setPending] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const [loadingError, setLoadingError] = useState(false);
	const [loadAttempt, setLoadAttempt] = useState(0);

	useEffect(() => {
		let cancelled = false;
		setState(null);
		setLoadingError(false);
		void Promise.all([
			listLorebooks(),
			owner === "character" ? getCharacterLorebookAttachments(ownerId) : getParticipantLorebookAttachments(ownerId),
		]).then(([loadedBooks, loadedState]) => {
			if (cancelled) return;
			setBooks(loadedBooks);
			setState(loadedState);
		}).catch(() => { if (!cancelled) setLoadingError(true); });
		return () => { cancelled = true; };
	}, [owner, ownerId, loadAttempt]);

	const bookNames = useMemo(() => new Map(books.map((book) => [book.id, book.name])), [books]);
	const send = async (command: LoreAttachmentCommand) => {
		setPending(true);
		setNotice(null);
		try {
			const result = await applyLorebookAttachmentCommand(command);
			if (result.outcome !== "available") {
				if (result.outcome === "conflict") setState(await (owner === "character" ? getCharacterLorebookAttachments(ownerId) : getParticipantLorebookAttachments(ownerId)));
				throw new Error(result.outcome === "invalid" || result.outcome === "unusable" ? result.reason : "Lorebook attachment changed elsewhere.");
			}
			const refreshed = owner === "character" ? await getCharacterLorebookAttachments(ownerId) : await getParticipantLorebookAttachments(ownerId);
			setState(refreshed);
		} catch { setNotice("Lorebook attachment could not be saved."); }
		finally { setPending(false); }
	};

	if (state === null) {
		if (loadingError) return <LoreAttachmentLoadError owner={owner} onRetry={() => { setState(null); setLoadAttempt((attempt) => attempt + 1); }} />;
		return <LoreAttachmentLoading owner={owner} />;
	}

	const attach = () => {
		const bookId = Number(selectedBookId);
		if (!Number.isInteger(bookId)) return;
		void send(owner === "character"
			? { type: "attach-character", characterId: ownerId, bookId, expectedRevision: state.revision, scope: selectedScope }
			: { type: "attach-participant", participantId: ownerId, bookId, expectedRevision: state.revision, scope: selectedScope });
	};
	const detach = (attachment: LorebookOwnerAttachmentState["attachments"][number]) => void send(owner === "character"
		? { type: "detach-character", characterId: ownerId, bookId: attachment.bookId, scope: attachment.scope, expectedRevision: state.revision }
		: { type: "detach-participant", participantId: ownerId, bookId: attachment.bookId, scope: attachment.scope, expectedRevision: state.revision });
	const toggle = (attachment: LorebookOwnerAttachmentState["attachments"][number]) => void send(owner === "character"
		? { type: "attach-character", characterId: ownerId, bookId: attachment.bookId, expectedRevision: state.revision, scope: attachment.scope, enabled: !attachment.enabled }
		: { type: "attach-participant", participantId: ownerId, bookId: attachment.bookId, expectedRevision: state.revision, scope: attachment.scope, enabled: !attachment.enabled });

	return <section className="editor-section" aria-label={`${ownerLabel(owner)} Lorebooks`}>
		<h3>Lorebooks</h3>
		<p className="panel-note">Attach shared books to this {ownerLabel(owner)}. Scope controls when the book can activate.</p>
		<div className="apply-row">
			<AppSelect
			className="field-input"
			value={selectedBookId}
			disabled={disabled || pending || books.length === 0}
			onValueChange={setSelectedBookId}
			aria-label="Lorebook to attach"
			emptyLabel="Select a Lorebook"
			options={books.map((book) => ({ value: book.id, label: book.name }))}
		/>
			<AppSelect
			className="field-input"
			value={selectedScope}
			disabled={disabled || pending}
			onValueChange={(value) => setSelectedScope(value === "controlled-participant" ? "controlled-participant" : "cast")}
			aria-label="Lorebook attachment scope"
			options={[
				{ value: "cast", label: "Cast" },
				{ value: "controlled-participant", label: "Controlled Participant" },
			]}
		/>
			<Button variant="outline" size="sm" type="button" disabled={disabled || pending || selectedBookId === ""} onClick={attach}>Attach</Button>
		</div>
		{state.attachments.length === 0 ? (
			<p className="panel-note">No Lorebooks attached.</p>
		) : (
			<ul className="lore-attachment-list">
				{state.attachments.map((attachment) => (
					<li className="apply-row" key={attachment.id}>
						<span>
							{bookNames.get(attachment.bookId) ?? `Book ${attachment.bookId}`} · {attachment.scope} · {attachment.enabled ? "Enabled" : "Disabled"}
						</span>
						<Button variant="outline" size="sm" type="button" disabled={disabled || pending} onClick={() => toggle(attachment)}>
							{attachment.enabled ? "Disable" : "Enable"}
						</Button>
						<Button variant="outline" size="sm" type="button" disabled={disabled || pending} onClick={() => detach(attachment)}>
							Detach
						</Button>
					</li>
				))}
			</ul>
		)}
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
		<ul className="lore-attachment-list" aria-hidden="true">
			{["first", "second"].map((key) => (
				<li className="apply-row" key={key}>
					<div className="h-5 flex-1 animate-pulse rounded bg-muted/50" />
					<div className="h-9 w-20 animate-pulse rounded-md bg-muted/50" />
					<div className="h-9 w-20 animate-pulse rounded-md bg-muted/50" />
				</li>
			))}
		</ul>
	</section>;
}

function LoreAttachmentLoadError({ owner, onRetry }: { owner: Owner; onRetry: () => void }) {
	return <section className="editor-section" aria-label={`${ownerLabel(owner)} Lorebooks`}>
		<h3>Lorebooks</h3>
		<p className="panel-note" role="alert">The {ownerLabel(owner).toLowerCase()} Lorebooks could not be loaded. Check your connection and try again.</p>
		<Button variant="outline" size="sm" type="button" onClick={onRetry}>Retry</Button>
	</section>;
}
