import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useReducer, useRef } from "react";
import { applyLorebookCommand, exportNativeLorebook, getLorebook, getLorebookAttachmentImpact, type Lorebook, type LorebookCommand, type LorebookCommandResult } from "../lorebook-library";
import { splitList, type EntryListKey } from "./lorebook-entry-fields";
import { editedSince, fieldsOf, blankEntry, initialEditorState, reduceLorebookEditor, sameEntry, type LeaveIntent, type LorebookEditorState, type EditorAction } from "./lorebook-editor-state";

interface SettleFlags { notice?: string; notFoundNotice?: string; newEntry?: boolean; enabled?: boolean; preserveBookDraft?: boolean }

export function useLorebookEditor(bookId: number) {
	const client = useQueryClient();
	const detail = useQuery({
		queryKey: ["lorebook", bookId], queryFn: async ({ signal }) => { await Promise.resolve(); signal.throwIfAborted(); return getLorebook(bookId, signal); },
		staleTime: Infinity, refetchOnReconnect: false,
	});
	const [state, reduce] = useReducer(reduceLorebookEditor, undefined, initialEditorState);
	const session = useRef(new AbortController());
	useEffect(() => {
		session.current = new AbortController();
		return () => session.current.abort();
	}, [bookId]);
	const current = useEffectEvent(() => state);
	const dispatch = (action: EditorAction) => {
		if (!session.current.signal.aborted) reduce(action);
	};
	if (state.book !== null && state.book.id !== bookId) reduce({ type: "reset" });
	else if (state.book === null && !detail.isFetching && detail.data) reduce({ type: "loaded", book: detail.data });
	useEffect(() => {
		if (detail.data) reduce({ type: "refreshed", book: detail.data });
	}, [detail.data]);
	const { book, bookDraft, entryDraft, entryId } = state;
	const selectedEntry = book?.entries.find((entry) => entry.id === entryId);
	const bookDirty = book !== null && (bookDraft.name !== book.name || bookDraft.description !== book.description);
	const entryDirty = book !== null && !sameEntry(entryDraft, selectedEntry === undefined ? blankEntry() : fieldsOf(selectedEntry));
	const dirty = bookDirty || entryDirty;
	const cacheBook = async (book: Lorebook, signal: AbortSignal) => {
		await client.cancelQueries({ queryKey: ["lorebook", book.id] });
		if (signal.aborted) return;
		client.setQueryData<Lorebook>(["lorebook", book.id], (current) => current && current.revision > book.revision ? current : book);
		void client.invalidateQueries({ queryKey: ["lorebooks"] });
	};
	const command = useMutation({
		mutationKey: ["lorebook", bookId, "command"],
		mutationFn: ({ action }: { action: LorebookCommand; signal: AbortSignal }) => applyLorebookCommand(action),
		onError: (error, submission) => { if (!submission.signal.aborted) setNotice(error.message); },
		onSuccess: async (result, submission) => {
			if (submission.signal.aborted) return;
			if (result.outcome === "available" && result.value.outcome === "applied") await cacheBook(result.value.book, submission.signal);
			else if (result.outcome === "conflict") await cacheBook(result.currentBook, submission.signal);
			else if (result.outcome === "available" && result.value.outcome === "deleted") {
				client.removeQueries({ queryKey: ["lorebook", result.value.bookId] });
				void client.invalidateQueries({ queryKey: ["lorebooks"] });
				void client.invalidateQueries({ queryKey: ["lorebook-attachments"] });
			}
		},
	});
	const settle = (result: LorebookCommandResult, submitted: LorebookEditorState, flags: SettleFlags = {}) => {
		if (result.outcome === "available" && result.value.outcome === "applied") {
			dispatch({ type: "applied", book: result.value.book, submitted, notice: flags.notice ?? null, newEntry: flags.newEntry, enabled: flags.enabled });
			return result.value.book;
		}
		if (result.outcome === "conflict") dispatch({ type: "applied", book: result.currentBook, submitted, preserveBookDraft: flags.preserveBookDraft,
			notice: "This Lorebook changed elsewhere. Your saved view was refreshed." });
		else dispatch({ type: "notice", notice: result.outcome === "invalid" || result.outcome === "unusable" ? result.reason : result.outcome === "not-found" ? flags.notFoundNotice ?? "That Lorebook no longer exists." : "The Lorebook operation failed." });
		return null;
	};
	const apply = async (action: LorebookCommand, submitted: LorebookEditorState, signal: AbortSignal) => {
		const result = await command.mutateAsync({ action, signal });
		if (signal.aborted) return null;
		return settle(result, submitted, {
			newEntry: action.type === "save-entry" && action.entryId === undefined, preserveBookDraft: true, notFoundNotice: "The Lorebook operation failed.",
		});
	};
	const save = useMutation({
		onError: (error, submission) => { if (!submission.signal.aborted) setNotice(error.message); },
		mutationKey: ["lorebook", bookId, "save"],
		mutationFn: async ({ submitted, signal }: { submitted: LorebookEditorState; signal: AbortSignal }) => {
			let saved = submitted.book;
			if (saved === null) return false;
			if (bookDirty) saved = await apply({ type: "update-book", bookId, expectedRevision: saved.revision, ...submitted.bookDraft }, submitted, signal);
			if (saved === null || signal.aborted) return false;
			if (entryDirty) {
				if (current().entryDraft !== submitted.entryDraft) return false;
				saved = await apply({ type: "save-entry", bookId, expectedRevision: saved.revision, entryId: submitted.entryId ?? undefined, entry: submitted.entryDraft }, submitted, signal);
			}
			if (saved === null || signal.aborted) return false;
			const unchanged = !editedSince(current(), submitted);
			if (unchanged) dispatch({ type: "notice", notice: "Lorebook saved." });
			return unchanged;
		},
	});
	const impact = useMutation({ mutationFn: () => getLorebookAttachmentImpact(bookId) });
	const exportFile = useMutation({ mutationFn: () => exportNativeLorebook(bookId) });
	const setNotice = (notice: string | null) => dispatch({ type: "notice", notice });
	const executeLorebookCommand = (action: LorebookCommand, success?: string, onOpenBook?: (id: number | null, notice?: string) => void) => {
		const signal = session.current.signal;
		command.mutate({ action, signal }, {
			onSuccess: (result) => {
				if (signal.aborted) return;
				if (result.outcome === "available" && result.value.outcome === "deleted") { onOpenBook?.(null, "Lorebook deleted."); return; }
				if (result.outcome === "available" && result.value.outcome === "applied" && result.value.book.id !== bookId) { onOpenBook?.(result.value.book.id, success); return; }
				settle(result, state, { notice: success, enabled: action.type === "set-entry-enabled" && action.entryId === entryId ? action.enabled : undefined });
			},
		});
	};
	const confirmDeleteBook = () => {
		const signal = session.current.signal;
		impact.mutate(undefined, {
			onSuccess: (value) => {
				if (signal.aborted) return;
				const attachments = value?.attachments.map((attachment) => attachment.ownerName).join("\n") ?? "";
				dispatch({ type: "book-delete-requested", confirmation: {
					name: book?.name ?? "", detail: attachments === "" ? "It has no attachments." : `Deleting it also removes these attachments:\n${attachments}`,
				} });
			},
			onError: (error) => { if (!signal.aborted) setNotice(error.message); },
		});
	};
	const exportBook = () => {
		const signal = session.current.signal;
		exportFile.mutate(undefined, {
			onSuccess: (value) => {
				if (signal.aborted) return;
				const link = document.createElement("a");
				link.href = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
				link.download = `${value.name}.json`; link.click(); URL.revokeObjectURL(link.href);
				setNotice(`Lorebook "${value.name}" exported.`);
			},
			onError: () => { if (!signal.aborted) setNotice(`Lorebook "${book?.name}" could not be exported. Please try again.`); },
		});
	};
	return {
		...state, name: bookDraft.name, description: bookDraft.description, selectedEntry, dirty,
		pending: command.isPending || save.isPending || exportFile.isPending,
		loadError: (detail.error ? "The Lorebook could not be loaded." : null) ?? (detail.isSuccess && detail.data === null ? "That Lorebook no longer exists." : null),
		setName: (name: string) => dispatch({ type: "book-edited", draft: { ...bookDraft, name } }),
		setDescription: (description: string) => dispatch({ type: "book-edited", draft: { ...bookDraft, description } }),
		updateEntryDraft: (draft: LorebookEditorState["entryDraft"]) => dispatch({ type: "entry-edited", draft }),
		updateList: (key: EntryListKey, value: string) => dispatch({ type: "entry-edited", draft: { ...entryDraft, [key]: splitList(value) } }),
		setLeaveIntent: (intent: LeaveIntent | null) => dispatch({ type: "leave-requested", intent }),
		selectEntry: (id: number | null) => dispatch({ type: "entry-selected", id }),
		discard: () => dispatch({ type: "discard" }),
		setBookDeleteConfirmation: (confirmation: LorebookEditorState["bookDeleteConfirmation"]) => dispatch({ type: "book-delete-requested", confirmation }),
		setEntryDeleteConfirmation: (open: boolean) => dispatch({ type: "entry-delete-requested", open }),
		saveDirty: () => save.mutateAsync({ submitted: state, signal: session.current.signal }), executeLorebookCommand, confirmDeleteBook, exportBook,
	};
}
