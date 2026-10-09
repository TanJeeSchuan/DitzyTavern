import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { mergeMemoryLabels, type ConversationMemories } from "../memories";

export function MemoryLabelMergeDialog({ conversationId, memories, initialLabels, onClose, onMerged }: {
	conversationId: number;
	memories: ConversationMemories;
	initialLabels: string[];
	onClose: () => void;
	onMerged: (memories: ConversationMemories, destination: string) => void;
}) {
	const [snapshot, setSnapshot] = useState(memories);
	const [labels, setLabels] = useState(initialLabels);
	const [destination, setDestination] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const listId = useId();
	const names = [...new Set(snapshot.sources.flatMap((source) => source.claims.flatMap((claim) => claim.people)))].sort((a, b) => a.localeCompare(b));
	const target = destination.trim();
	const affected = snapshot.sources.flatMap((source) =>
		source.claims.flatMap((claim, index) =>
			claim.people.some((name) => labels.includes(name) && name !== target)
				? [{ source, claim, index }]
				: [],
		));
	const save = async (event: FormEvent) => {
		event.preventDefault();
		setPending(true); setError(null);
		try {
			const result = await mergeMemoryLabels(conversationId, { expectedRevision: snapshot.labelRevision, labels, destination: target });
			if (result.outcome === "available") onMerged(result.value.memories, target);
			else if (result.outcome === "conflict") {
				setSnapshot(result.memories); setLabels([]);
				setError("These labels changed elsewhere. Review the current labels and select them again.");
			}
			else setError(result.outcome === "invalid" || result.outcome === "unusable" ? result.reason : "Labels could not be merged. Try again.");
		} catch { setError("Labels could not be merged. Try again."); }
		finally { setPending(false); }
	};
	return <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
		<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg" showCloseButton={!pending}>
			<DialogHeader>
				<DialogTitle>Merge labels</DialogTitle>
				<DialogDescription>Use one name for these labels across this Chat, including other Swipes and future Memories.</DialogDescription>
			</DialogHeader>
			<form className="memory-merge-form" onSubmit={(event) => void save(event)}>
				<fieldset disabled={pending}>
					<legend className="field-label">Labels to merge</legend>
					<ToggleGroup type="multiple" size="sm" variant="outline" spacing={4} className="memory-people" aria-label="Labels to merge" value={labels} onValueChange={setLabels}>
						{names.map((name) => <ToggleGroupItem key={name} value={name}>{name}</ToggleGroupItem>)}
					</ToggleGroup>
				</fieldset>
				<label className="field">
					<span className="field-label">Merge into</span>
					<input
						className="field-input"
						list={listId}
						placeholder="Choose an existing name or type a new one"
						value={destination}
						maxLength={1024}
						onChange={(event) => setDestination(event.target.value)}
						disabled={pending}
						required
					/>
				</label>
				<datalist id={listId}>{names.map((name) => <option key={name} value={name} />)}</datalist>
				{labels.length > 0 && target && <section className="memory-merge-preview" aria-label="Merge preview">
					<p className="field-label">{affected.length} {affected.length === 1 ? "Memory" : "Memories"} will use {target}</p>
					<div className="memory-merge-claims">{affected.map(({ source, claim, index }) => <div key={`${source.variantId}:${index}`}>
						<p>{claim.claim}</p>
						<small>{[...new Set(claim.people.map((name) => labels.includes(name) ? target : name))].join(", ")}{!source.selected && " · Other Swipe"}</small>
					</div>)}</div>
				</section>}
				<p className="memory-empty">Memory text and source excerpts stay unchanged.</p>
				{error && <p className="import-problem" role="alert">{error}</p>}
				<DialogFooter>
					<Button type="button" variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button>
					<Button type="submit" disabled={pending || !target || affected.length === 0}>{pending ? "Merging…" : "Merge labels"}</Button>
				</DialogFooter>
			</form>
		</DialogContent>
	</Dialog>;
}
