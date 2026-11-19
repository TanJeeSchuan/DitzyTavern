import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { AppSelect } from "@/components/ui/select";
import {
	getCharacterLorebookAttachments,
	getParticipantLorebookAttachments,
	listLorebooks,
	type LorebookOwnerAttachmentState,
} from "../lorebook-library";

type Owner = "character" | "participant";
type Attachment = LorebookOwnerAttachmentState["attachments"][number];
type AttachmentEdit = Pick<Attachment, "bookId" | "scope"> & (
	| { type: "attach"; enabled?: boolean }
	| { type: "detach" }
);

const ownerLabel = (owner: Owner): string => owner === "character" ? "Character" : "Participant";

export function LoreAttachmentEditor({ owner, ownerId, disabled, onCommand }: {
	owner: Owner;
	ownerId: number;
	disabled: boolean;
	onCommand: (edit: AttachmentEdit, revision: number) => Promise<boolean>;
}) {
	const client = useQueryClient();
	const readAttachments = owner === "character" ? getCharacterLorebookAttachments : getParticipantLorebookAttachments;
	const attachments = useQuery({ queryKey: ["lorebook-attachments", owner, ownerId], queryFn: ({ signal }) => readAttachments(ownerId, signal) });
	const library = useQuery({ queryKey: ["lorebooks"], queryFn: ({ signal }) => listLorebooks(signal) });
	const state = attachments.data ?? null;
	const books = library.data ?? [];
	const [selectedBookId, setSelectedBookId] = useState("");
	const [selectedScope, setSelectedScope] = useState<Attachment["scope"]>("cast");
	const write = useMutation({
		networkMode: "always",
		mutationFn: async ({ edit, revision }: { edit: AttachmentEdit; revision: number }) => {
			const applied = await onCommand(edit, revision);
			const refreshed = await client.invalidateQueries({ queryKey: ["lorebook-attachments"] }, { throwOnError: true }).then(() => true, () => false);
			if (!applied || !refreshed) throw new Error("Lorebook attachment could not be saved.");
		},
	});
	const controlsDisabled = disabled || write.isPending || attachments.isFetching;

	if ((attachments.isError && state === null) || (library.isError && library.data === undefined)) {
		return <LoreAttachmentLoadError owner={owner} onRetry={() => { void attachments.refetch(); void library.refetch(); }} />;
	}
	if (state === null || library.data === undefined) {
		return <LoreAttachmentLoading owner={owner} />;
	}

	const bookNames = new Map(books.map((book) => [book.id, book.name]));
	const send = (edit: AttachmentEdit) => write.mutate({ edit, revision: state.revision });
	const attach = () => {
		const bookId = Number(selectedBookId);
		if (!Number.isInteger(bookId)) return;
		send({ type: "attach", bookId, scope: selectedScope });
	};
	const detach = ({ bookId, scope }: Attachment) => send({ type: "detach", bookId, scope });
	const toggle = ({ bookId, scope, enabled }: Attachment) => send({ type: "attach", bookId, scope, enabled: !enabled });

	return <section className="editor-section" aria-label={`${ownerLabel(owner)} Lorebooks`}>
		<h3>Lorebooks</h3>
		<p className="panel-note">Attach shared books to this {ownerLabel(owner)}. Scope controls when the book can activate.</p>
		<div className="apply-row">
			<AppSelect
			className="field-input"
			value={selectedBookId}
			disabled={controlsDisabled || books.length === 0}
			onValueChange={setSelectedBookId}
			aria-label="Lorebook to attach"
			emptyLabel="Select a Lorebook"
			options={books.map((book) => ({ value: book.id, label: book.name }))}
		/>
			<AppSelect
			className="field-input"
			value={selectedScope}
			disabled={controlsDisabled}
			onValueChange={(value) => setSelectedScope(value === "controlled-participant" ? "controlled-participant" : "cast")}
			aria-label="Lorebook attachment scope"
			options={[
				{ value: "cast", label: "Cast" },
				{ value: "controlled-participant", label: "Controlled Participant" },
			]}
		/>
			<Button variant="outline" size="sm" type="button" disabled={controlsDisabled || selectedBookId === ""} onClick={attach}>Attach</Button>
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
						<Button variant="outline" size="sm" type="button" disabled={controlsDisabled} onClick={() => toggle(attachment)}>
							{attachment.enabled ? "Disable" : "Enable"}
						</Button>
						<Button variant="outline" size="sm" type="button" disabled={controlsDisabled} onClick={() => detach(attachment)}>
							Detach
						</Button>
					</li>
				))}
			</ul>
		)}
		{write.error !== null && <p className="panel-note" role="status">{write.error.message}</p>}
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
