import { useEffect, useId, useRef, useState, type Ref } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AppSelect } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ProseEditor, type ProseEditorHandle } from "./editor/ProseEditor";
import { commandPainting, illustrationsKey, usePaintingCommand } from "./painting";
import type { ReferenceSet } from "../shared/contract/painting";

export function useReferenceDraft(conversationId: number, selected: ReferenceSet | undefined) {
	const client = useQueryClient();
	const [draft, setDraft] = useState<ReferenceSet | null>(null);
	const [error, setError] = useState<string | null>(null);
	const pending = useRef<ReferenceSet | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const saving = useRef(Promise.resolve(true));
	const flush = () => {
		clearTimeout(timer.current);
		saving.current = saving.current.then(async () => {
			const set = pending.current;
			if (set === null) return true;
			const result = await commandPainting(conversationId, { type: "save-reference-set", id: set.id, references: set.references });
			if (result.outcome !== "available") {
				setError(result.outcome === "invalid" || result.outcome === "unusable" ? result.reason : "The References could not be saved.");
				return false;
			}
			if (pending.current === set) pending.current = null;
			await client.invalidateQueries({ queryKey: illustrationsKey(conversationId) });
			return true;
		});
		return saving.current;
	};
	const flushOnUnmount = useRef(flush);
	useEffect(() => { flushOnUnmount.current = flush; });
	useEffect(() => () => void flushOnUnmount.current(), []);
	return {
		references: draft !== null && draft.id === selected?.id ? draft.references : selected?.references ?? "",
		error,
		edit: (references: string) => {
			if (selected === undefined) return;
			const set = { ...selected, references };
			setDraft(set);
			setError(null);
			pending.current = set;
			clearTimeout(timer.current);
			timer.current = setTimeout(() => void flush(), 600);
		},
		flush,
		discard: () => {
			clearTimeout(timer.current);
			pending.current = null;
			return flush();
		},
	};
}

type Naming = { kind: "new" | "rename"; name: string };

export function ReferenceSetField({ conversationId, sets, selected, draft, editorRef, disabled }: {
	conversationId: number;
	sets: readonly ReferenceSet[];
	selected: ReferenceSet | undefined;
	draft: ReturnType<typeof useReferenceDraft>;
	editorRef: Ref<ProseEditorHandle>;
	disabled: boolean;
}) {
	const headingId = useId();
	const { submit, pending, error } = usePaintingCommand(conversationId);
	const [naming, setNaming] = useState<Naming | null>(null);
	const busy = disabled || pending || selected === undefined;
	const switchTo = async (command: Parameters<typeof submit>[0]) => await draft.flush() && submit(command);
	return <section className="grid min-w-0 gap-2" aria-labelledby={headingId}>
		<h3 id={headingId} className="text-sm font-medium">References</h3>
		{naming === null ? <div className="flex min-w-0 items-center gap-2">
			<AppSelect aria-label="Reference Set" className="field-input min-w-0 flex-1" value={selected?.id ?? ""} disabled={busy}
				options={sets.map(({ id, name }) => ({ value: id, label: name }))} onValueChange={(id) => void switchTo({ type: "select-reference-set", id })} />
			<Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setNaming({ kind: "new", name: "" })}><Plus aria-hidden="true" />New</Button>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button type="button" size="icon-sm" variant="ghost" aria-label="Reference Set actions" title="Reference Set actions" disabled={busy}><MoreHorizontal aria-hidden="true" /></Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-auto">
					<DropdownMenuItem onSelect={() => setNaming({ kind: "rename", name: selected?.name ?? "" })}>Rename</DropdownMenuItem>
					<DropdownMenuItem variant="destructive" disabled={sets.length === 1} onSelect={() => {
						if (selected === undefined) return;
						void draft.discard().then(() => submit({ type: "delete-reference-set", id: selected.id }));
					}}>Delete</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</div> : <form className="flex min-w-0 items-center gap-2" aria-label={naming.kind === "new" ? "New Reference Set" : "Rename Reference Set"} onSubmit={async (event) => {
			event.preventDefault();
			const name = naming.name.trim();
			if (!name || selected === undefined) return;
			const saved = naming.kind === "new"
				? await switchTo({ type: "create-reference-set", name, references: draft.references })
				: await submit({ type: "rename-reference-set", id: selected.id, name });
			if (saved) setNaming(null);
		}}>
			<Input aria-label="Reference Set name" className="min-w-0 flex-1" autoFocus value={naming.name} placeholder={naming.kind === "new" ? "Name the copy" : undefined}
				onChange={(event) => setNaming({ ...naming, name: event.currentTarget.value })} onKeyDown={(event) => { if (event.key === "Escape") setNaming(null); }} />
			<Button type="submit" size="sm" disabled={pending || !naming.name.trim()}>{naming.kind === "new" ? "Create" : "Rename"}</Button>
			<Button type="button" size="sm" variant="ghost" onClick={() => setNaming(null)}>Cancel</Button>
		</form>}
		<ProseEditor className="prose-editor-field" ref={editorRef} ariaLabel="References" value={draft.references} onChange={draft.edit} disabled={busy} />
		<small className="text-xs text-muted-foreground">Sent after the Brief. Writing a Brief never changes them. Press a picture below to insert it here.</small>
		{(error ?? draft.error) !== null && <p role="alert" className="text-sm text-destructive">{error ?? draft.error}</p>}
	</section>;
}
