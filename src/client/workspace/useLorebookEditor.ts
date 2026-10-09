import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useReducer, useRef } from "react";
import { applyLorebookCommand, exportNativeLorebook, getLorebook, getLorebookAttachmentImpact, type Lorebook, type LorebookCommand, type LorebookCommandResult } from "../lorebook-library";
import { splitList, type EntryListKey } from "./lorebook-entry-fields";
import { editedSince, fieldsOf, blankEntry, initialEditorState, reduceLorebookEditor, sameEntry, type LeaveIntent, type LorebookEditorState, type EditorAction } from "./lorebook-editor-state";

interface SettleFlags { notice?: string; notFoundNotice?: string; newEntry?: boolean; enabled?: boolean; preserveBookDraft?: boolean }

export function useLorebookEditor(bookId: number) {
	const client = useQueryClient();
	const detail = useQuery({ queryKey: ["lorebook", bookId], queryFn: ({ signal }) => getLorebook(bookId, signal), staleTime: Infinity, refetchOnMount: "always" });
	const [state, reduce] = useReducer(reduceLorebookEditor, undefined, initialEditorState);
	const current = useRef<LorebookEditorState | null>(state);
	current.current = state;
	useEffect(() => {
		return () => { current.current = null; };
	}, []);
	const dispatch = (action: EditorAction) => {
		if (current.current !== null) current.current = reduceLorebookEditor(current.current, action);
		reduce(action);
	};
	if (state.book === null && !detail.isFetching && detail.data) dispatch({ type: "loaded", book: detail.data });
	const { book, bookDraft, entryDraft, entryId } = state;
	const selectedEntry = book?.entries.find((entry) => entry.id === entryId);
	const bookDirty = book !== null && (bookDraft.name !== book.name || bookDraft.description !== book.description);
	const entryDirty = book !== null && !sameEntry(entryDraft, selectedEntry === undefined ? blankEntry() : fieldsOf(selectedEntry));
	const dirty = bookDirty || entryDirty;
	const cacheBook = async (book: Lorebook) => {
		await client.cancelQueries({ queryKey: ["lorebook", book.id] });
		client.setQueryData(["lorebook", book.id], book);
		void client.invalidateQueries({ queryKey: ["lorebooks"] });
	};
	const command = useMutation({
		mutationFn: applyLorebookCommand,
		onError: (error) => setNotice(error.message),
		onSuccess: async (result) => {
			if (result.outcome === "available" && result.value.outcome === "applied") await cacheBook(result.value.book);
			else if (result.outcome === "conflict") await cacheBook(result.currentBook);
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
	const apply = async (action: LorebookCommand, submitted: LorebookEditorState) => {
		const result = await command.mutateAsync(action);
		if (current.current === null) return null;
		return settle(result, submitted, { newEntry: action.type === "save-entry" && action.entryId === undefined, preserveBookDraft: true, notFoundNotice: "The Lorebook operation failed." });
	};
	const save = useMutation({
		onError: (error) => setNotice(error.message),
		mutationFn: async (submitted: LorebookEditorState) => {
			let saved = submitted.book;
			if (saved === null) return false;
			if (bookDirty) saved = await apply({ type: "update-book", bookId, expectedRevision: saved.revision, ...submitted.bookDraft }, submitted);
			if (saved === null || current.current === null) return false;
			if (entryDirty) {
				if (current.current.entryDraft !== submitted.entryDraft) return false;
				saved = await apply({ type: "save-entry", bookId, expectedRevision: saved.revision, entryId: submitted.entryId ?? undefined, entry: submitted.entryDraft }, submitted);
			}
			if (saved === null || current.current === null) return false;
			const unchanged = !editedSince(current.current, submitted);
			if (unchanged) dispatch({ type: "notice", notice: "Lorebook saved." });
			return unchanged;
		},
	});
	const impact = useMutation({ mutationFn: () => getLorebookAttachmentImpact(bookId) });
	const exportFile = useMutation({ mutationFn: () => exportNativeLorebook(bookId) });
	const setNotice = (notice: string | null) => dispatch({ type: "notice", notice });
	const executeLorebookCommand = (action: LorebookCommand, success?: string, onOpenBook?: (id: number | null, notice?: string) => void) => {
		command.mutate(action, {
			onSuccess: (result) => {
				if (result.outcome === "available" && result.value.outcome === "deleted") { onOpenBook?.(null, "Lorebook deleted."); return; }
				if (result.outcome === "available" && result.value.outcome === "applied" && result.value.book.id !== bookId) { onOpenBook?.(result.value.book.id, success); return; }
				settle(result, state, { notice: success, enabled: action.type === "set-entry-enabled" && action.entryId === entryId ? action.enabled : undefined });
			},
		});
	};
	const confirmDeleteBook = () => impact.mutate(undefined, {
		onSuccess: (value) => {
			const attachments = value?.attachments.map((attachment) => attachment.ownerName).join("\n") ?? "";
			dispatch({ type: "book-delete-requested", confirmation: {
				name: book?.name ?? "", detail: attachments === "" ? "It has no attachments." : `Deleting it also removes these attachments:\n${attachments}`,
			} });
		},
		onError: (error) => setNotice(error.message),
	});
	const exportBook = () => exportFile.mutate(undefined, {
		onSuccess: (value) => {
			const link = document.createElement("a");
			link.href = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
			link.download = `${value.name}.json`; link.click(); URL.revokeObjectURL(link.href);
			setNotice(`Lorebook "${value.name}" exported.`);
		},
		onError: () => setNotice(`Lorebook "${book?.name}" could not be exported. Please try again.`),
	});
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
		saveDirty: () => save.mutateAsync(state), executeLorebookCommand, confirmDeleteBook, exportBook,
	};
}
