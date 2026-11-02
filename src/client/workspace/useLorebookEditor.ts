import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import { useEffect, useEffectEvent, useReducer } from "react";
import { foldNewer, useVisitSignal } from "../lib/visit";
import { applyLorebookCommand, exportNativeLorebook, getLorebook, getLorebookAttachmentImpact, type Lorebook, type LorebookCommand, type LorebookCommandResult } from "../lorebook-library";
import { splitList, type EntryListKey } from "./lorebook-entry-fields";
import type { DraftEvent, DraftSession, Revisioned } from "../lib/revisioned-draft";
import type { LoreEntryFields } from "../../shared/contract/lorebook";
import {
	blankEntry, bookFieldsOf, draftValue, entryFieldsOf, initialEditorState, reduceLorebookEditor, unsaved,
	type BookDeleteConfirmation, type BookFields, type EditorAction, type LeaveIntent, type LorebookEditorState,
} from "./lorebook-editor-state";

const CHANGED_ELSEWHERE = "This Lorebook changed elsewhere. Your saved view was refreshed.";
const failureNotice = (result: LorebookCommandResult, notFound: string) => result.outcome === "invalid" || result.outcome === "unusable"
	? result.reason
	: result.outcome === "not-found" ? notFound : "The Lorebook operation failed.";

/** @approved How a save reaches one of the editor's two drafts. */
interface DraftTarget<T> {
	action: (event: DraftEvent<T>, entryId?: number | null) => EditorAction;
	project: (book: Lorebook, entryId: number | null) => Revisioned<T>;
	session: (state: LorebookEditorState) => DraftSession<T> | null;
}
const bookTarget: DraftTarget<BookFields> = { action: (event) => ({ type: "book-draft", event }), project: bookFieldsOf, session: (state) => state.bookDraft };
const entryTarget: DraftTarget<LoreEntryFields> = { action: (event, entryId) => ({ type: "entry-draft", event, entryId }), project: entryFieldsOf, session: (state) => state.entryDraft };

export function useLorebookEditor(bookId: number) {
	const client = useQueryClient();
	const detail = useQuery({
		queryKey: ["lorebook", bookId], queryFn: async ({ signal }) => { await Promise.resolve(); signal.throwIfAborted(); return getLorebook(bookId, signal); },
		staleTime: Infinity, refetchOnReconnect: false,
	});
	const [state, reduce] = useReducer(reduceLorebookEditor, undefined, initialEditorState);
	const signal = useVisitSignal(bookId);
	const current = useEffectEvent(() => state);
	const dispatch = (action: EditorAction) => {
		if (!signal.aborted) flushSync(() => reduce(action));
	};
	if (state.book !== null && state.book.id !== bookId) reduce({ type: "reset" });
	else if (state.book === null && !detail.isFetching && detail.data) reduce({ type: "loaded", book: detail.data });
	useEffect(() => {
		if (detail.data) reduce({ type: "refreshed", book: detail.data });
	}, [detail.data]);
	const { book, bookDraft, entryDraft, entryId } = state;
	const selectedEntry = book?.entries.find((entry) => entry.id === entryId);
	const bookFields = draftValue(bookDraft, { name: "", description: "" });
	const entryFields = draftValue(entryDraft, blankEntry());
	const conflict = bookDraft?.status === "conflict" || entryDraft?.status === "conflict";
	// @approved
	//  A draft still in flight counts as unsaved: its save may yet fail, so leaving waits for it.
	const dirty = (bookDraft !== null && bookDraft.status !== "clean") || (entryDraft !== null && entryDraft.status !== "clean");
	const cacheBook = (book: Lorebook) => {
		foldNewer(client, ["lorebook", book.id], book, (read) => read.revision);
		void client.invalidateQueries({ queryKey: ["lorebooks"] });
	};
	const command = useMutation({
		mutationKey: ["lorebook", bookId, "command"],
		mutationFn: ({ action }: { action: LorebookCommand; signal: AbortSignal }) => applyLorebookCommand(action),
		onError: (error, submission) => { if (!submission.signal.aborted) setNotice(error.message); },
		onSuccess: (result, submission) => {
			if (submission.signal.aborted) return;
			if (result.outcome === "available" && result.value.outcome === "applied") cacheBook(result.value.book);
			else if (result.outcome === "conflict") cacheBook(result.currentBook);
			else if (result.outcome === "available" && result.value.outcome === "deleted") {
				client.removeQueries({ queryKey: ["lorebook", result.value.bookId] });
				void client.invalidateQueries({ queryKey: ["lorebooks"] });
				void client.invalidateQueries({ queryKey: ["lorebook-attachments"] });
			}
		},
	});
	// @approved
	//  Settles one draft's save: the draft takes the copy it wrote or lost to,
	// and the other draft observes that copy. An unrelated revision move keeps
	// the draft unsaved and says the view was refreshed; a real conflict shows
	// its banner instead.
	const settleDraft = <T,>(target: DraftTarget<T>, result: LorebookCommandResult, submitted: T, newEntry: boolean): Lorebook | null => {
		const live = current();
		if (result.outcome === "available" && result.value.outcome === "applied") {
			const saved = result.value.book;
			const entryId = newEntry ? saved.entries.at(-1)?.id ?? null : live.entryId;
			dispatch(target.action({ type: "saved", submitted, saved: target.project(saved, entryId) }, entryId));
			dispatch({ type: "applied", book: saved, notice: null });
			return saved;
		}
		if (result.outcome === "conflict") {
			dispatch(target.action({ type: "conflicted", submitted, theirs: target.project(result.currentBook, live.entryId) }));
			const lost = target.session(current())?.status === "conflict";
			dispatch({ type: "applied", book: result.currentBook, notice: lost ? null : CHANGED_ELSEWHERE });
			return null;
		}
		dispatch(target.action({ type: "failed", submitted }));
		dispatch({ type: "notice", notice: failureNotice(result, "The Lorebook operation failed.") });
		return null;
	};
	const save = useMutation({
		onError: (error, submission) => { if (!submission.signal.aborted) setNotice(error.message); },
		mutationKey: ["lorebook", bookId, "save"],
		mutationFn: async ({ signal }: { signal: AbortSignal }) => {
			const start = current();
			if (start.book === null || start.bookDraft === null || start.entryDraft === null) return false;
			if (start.bookDraft.status === "conflict" || start.entryDraft.status === "conflict") return false;
			// @approved
			//  The save reports success only when nothing changed while it ran:
			// no edit, and no other entry selected.
			let untouched = true;
			const claims = <T>(session: DraftSession<T> | null, submitted: T) => session?.status === "saving" && session.submitted === submitted && !session.edited;
			if (start.bookDraft.status === "dirty") {
				const submitted = start.bookDraft.mine;
				dispatch({ type: "book-draft", event: { type: "save-started", submitted } });
				const result = await command.mutateAsync({ action: { type: "update-book", bookId, expectedRevision: start.bookDraft.base.revision, ...submitted }, signal });
				if (signal.aborted) return false;
				untouched &&= claims(current().bookDraft, submitted);
				if (settleDraft(bookTarget, result, submitted, false) === null) return false;
			}
			const live = current();
			if (start.entryDraft.status === "dirty") {
				// @approved
				//  An entry edited or left while the book saved is not the draft this save carries.
				if (live.entryId !== start.entryId || live.entryDraft?.status !== "dirty" || live.entryDraft.mine !== start.entryDraft.mine) return false;
				const submitted = live.entryDraft.mine;
				dispatch({ type: "entry-draft", event: { type: "save-started", submitted } });
				const action: LorebookCommand = { type: "save-entry", bookId, expectedRevision: live.entryDraft.base.revision, entryId: live.entryId ?? undefined, entry: submitted };
				const result = await command.mutateAsync({ action, signal });
				if (signal.aborted) return false;
				untouched &&= claims(current().entryDraft, submitted);
				if (settleDraft(entryTarget, result, submitted, live.entryId === null) === null) return false;
			}
			const settled = current();
			const unchanged = untouched && settled.entryId === (start.entryId ?? settled.entryId) && !unsaved(settled.bookDraft) && !unsaved(settled.entryDraft);
			if (unchanged) dispatch({ type: "notice", notice: "Lorebook saved." });
			return unchanged;
		},
	});
	const impact = useMutation({ mutationFn: () => getLorebookAttachmentImpact(bookId) });
	const exportFile = useMutation({ mutationFn: () => exportNativeLorebook(bookId) });
	const setNotice = (notice: string | null) => dispatch({ type: "notice", notice });
	const executeLorebookCommand = (action: LorebookCommand, success?: string, onOpenBook?: (id: number | null, notice?: string) => void) => {
		command.mutate({ action, signal }, {
			onSuccess: (result) => {
				if (signal.aborted) return;
				if (result.outcome === "available" && result.value.outcome === "deleted") { onOpenBook?.(null, "Lorebook deleted."); return; }
				if (result.outcome === "available" && result.value.outcome === "applied" && result.value.book.id !== bookId) { onOpenBook?.(result.value.book.id, success); return; }
				if (result.outcome === "available" && result.value.outcome === "applied") {
					dispatch({ type: "applied", book: result.value.book, notice: success ?? null, enabled: action.type === "set-entry-enabled" && action.entryId === current().entryId ? action.enabled : undefined });
				} else if (result.outcome === "conflict") dispatch({ type: "applied", book: result.currentBook, notice: CHANGED_ELSEWHERE });
				else dispatch({ type: "notice", notice: failureNotice(result, "That Lorebook no longer exists.") });
			},
		});
	};
	const confirmDeleteBook = () => {
		impact.mutate(undefined, {
			onSuccess: (value) => {
				if (signal.aborted) return;
				const attachments = value?.attachments.map((attachment) => attachment.ownerName).join("\n") ?? "";
				dispatch({ type: "dialog-opened", dialog: { type: "book-delete", confirmation: {
					name: book?.name ?? "", detail: attachments === "" ? "It has no attachments." : `Deleting it also removes these attachments:\n${attachments}`,
				} } });
			},
			onError: (error) => { if (!signal.aborted) setNotice(error.message); },
		});
	};
	const exportBook = () => {
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
		...state, name: bookFields.name, description: bookFields.description, entryDraft: entryFields, selectedEntry, dirty, conflict,
		pending: command.isPending || save.isPending || exportFile.isPending,
		loadError: (detail.error ? "The Lorebook could not be loaded." : null) ?? (detail.isSuccess && detail.data === null ? "That Lorebook no longer exists." : null),
		setName: (name: string) => dispatch({ type: "book-draft", event: { type: "edited", mine: { ...draftValue(current().bookDraft, bookFields), name } } }),
		setDescription: (description: string) => dispatch({ type: "book-draft", event: { type: "edited", mine: { ...draftValue(current().bookDraft, bookFields), description } } }),
		updateEntryDraft: (draft: LoreEntryFields) => dispatch({ type: "entry-draft", event: { type: "edited", mine: draft } }),
		updateList: (key: EntryListKey, value: string) => dispatch({ type: "entry-draft", event: { type: "edited", mine: { ...draftValue(current().entryDraft, entryFields), [key]: splitList(value) } } }),
		setLeaveIntent: (intent: LeaveIntent | null) => dispatch(intent === null ? { type: "dialog-closed" } : { type: "dialog-opened", dialog: { type: "leave", intent } }),
		selectEntry: (id: number | null) => dispatch({ type: "entry-selected", id }),
		discard: () => dispatch({ type: "discard" }),
		keepMine: () => dispatch({ type: "keep-mine" }),
		setBookDeleteConfirmation: (confirmation: BookDeleteConfirmation | null) => dispatch(confirmation === null ? { type: "dialog-closed" } : { type: "dialog-opened", dialog: { type: "book-delete", confirmation } }),
		setEntryDeleteConfirmation: (open: boolean) => dispatch(open ? { type: "dialog-opened", dialog: { type: "entry-delete" } } : { type: "dialog-closed" }),
		saveDirty: () => save.mutateAsync({ signal }), executeLorebookCommand, confirmDeleteBook, exportBook,
	};
}
