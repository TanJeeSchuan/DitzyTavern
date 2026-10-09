import { useId, useState, type FormEvent } from "react";
import { RadioGroup } from "radix-ui";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { MemoryIdentity } from "../../shared/contract/memory";
import { applyMemoryPeople } from "../../shared/memory-identity";
import { saveMemoryIdentity, type ConversationMemories } from "../memories";

export function MemoryIdentityDialog({ conversationId, participant, memories, initialKind, onClose, onSaved }: {
	conversationId: number;
	participant: { id: number; name: string };
	memories: ConversationMemories;
	initialKind?: MemoryIdentity["kind"];
	onClose: () => void;
	onSaved: (memories: ConversationMemories) => void;
}) {
	const [snapshot, setSnapshot] = useState(memories);
	const current = snapshot.identities[participant.id];
	const [kind, setKind] = useState<MemoryIdentity["kind"]>(initialKind ?? current?.kind ?? "themselves");
	const [person, setPerson] = useState(current?.kind === "plays" ? current.person : "");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const listId = useId();
	const target = person.trim();
	const identity: MemoryIdentity = kind === "plays" ? { kind, person: target } : { kind };
	const identities = { ...snapshot.identities, [participant.id]: identity };
	const personLabel = applyMemoryPeople([participant.name], snapshot.cast, identities, snapshot.labelMerges)[0];
	const ownMessages = new Set(snapshot.path.filter((entry) => entry.authorParticipantId === participant.id).map((entry) => entry.messageId));
	const names = [...new Set(snapshot.sources.flatMap((source) => source.claims.flatMap((claim) => claim.people)))].sort((a, b) => a.localeCompare(b));
	const affected = snapshot.sources.flatMap((source) => source.claims.flatMap((claim, index) => {
		const removed = kind === "excluded" && ownMessages.has(source.messageId);
		const people = applyMemoryPeople(claim.people, snapshot.cast, identities, snapshot.labelMerges);
		return removed || JSON.stringify(people) !== JSON.stringify(claim.people) ? [{ source, claim, index, removed, people }] : [];
	}));
	const save = async (event: FormEvent) => {
		event.preventDefault(); setPending(true); setError(null);
		try {
			const result = await saveMemoryIdentity(conversationId, { expectedRevision: snapshot.labelRevision, participantId: participant.id, identity });
			if (result.outcome === "available") onSaved(result.value.memories);
			else if (result.outcome === "conflict") {
				setSnapshot(result.memories);
				setError("Memory settings changed elsewhere. Review the updated preview before applying again.");
			}
			else setError(result.outcome === "invalid" ? result.reason : "Memory identity could not be saved. Try again.");
		} catch { setError("Memory identity could not be saved. Try again."); }
		finally { setPending(false); }
	};
	return <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
		<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg" showCloseButton={!pending}>
			<DialogHeader>
				<DialogTitle>{participant.name} in the story</DialogTitle>
				<DialogDescription>Choose how {participant.name}'s Messages contribute to Memories in this Chat.</DialogDescription>
			</DialogHeader>
			<form className="memory-merge-form" onSubmit={(event) => void save(event)}>
				<RadioGroup.Root aria-label="In the story as" value={kind} disabled={pending} onValueChange={(value: MemoryIdentity["kind"]) => setKind(value)} className="grid gap-3">
					{([ ["themselves", "Themselves"], ["excluded", "Not in the story"], ["plays", "Plays a person"] ] as const).map(([value, label]) => <label key={value} className="flex items-center gap-2 text-sm">
						<RadioGroup.Item
							value={value}
							className="flex size-4 shrink-0 items-center justify-center rounded-full border border-input outline-none focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=checked]:border-primary"
						>
							<RadioGroup.Indicator className="size-2 rounded-full bg-primary" />
						</RadioGroup.Item>
						{label}
					</label>)}
				</RadioGroup.Root>
				{kind === "plays" && (
				<label className="field">
					<span className="field-label">Person name</span>
					<input
						className="field-input"
						list={listId}
						placeholder="Choose an existing name or type a new one"
						value={person}
						maxLength={1024}
						onChange={(event) => setPerson(event.target.value)}
						disabled={pending}
						required
					/>
				</label>
			)}
				<datalist id={listId}>{names.map((name) => <option key={name} value={name} />)}</datalist>
				{kind === "plays" && !target ? (
				<p className="memory-empty">Enter a person name to preview the affected Memories.</p>
			) : (
				<section className="memory-merge-preview" aria-label="Identity preview" aria-live="polite">
					{kind === "excluded" && <p className="field-label">{affected.filter((entry) => entry.removed).length} Memories sourced from {participant.name}'s Messages will be removed</p>}
					{kind !== "themselves" && (
					<p className="field-label">
						{affected.filter((entry) => !entry.removed).length} Memories {kind === "excluded"
							? `will drop the ${participant.name} label`
							: `will use ${personLabel || "the person name"}`}
					</p>
				)}
					<p className="memory-empty">{kind === "excluded" ? ownMessages.size : 0} Messages will be skipped by history catch-up</p>
					<div className="memory-merge-claims">
					{affected.slice(0, 8).map(({ source, claim, index, removed, people }) => (
						<div
							key={`${source.variantId}:${index}`}
						>
							<p>{removed ? <s>{claim.claim}</s> : claim.claim}</p>
							<small>
								{removed ? "Removed" : people.join(", ") || "Unlabelled"}
								{!source.selected && " · Other Swipe"}
							</small>
						</div>
					))}
				</div>
					{affected.length > 8 && <p className="memory-empty">And {affected.length - 8} more Memories</p>}
				</section>
			)}
				<p className="memory-empty">Themselves stops excluding or rewriting future Memories. Removed Memories can be extracted again with Remember history.</p>
				{error && <p className="import-problem" role="alert">{error}</p>}
				<DialogFooter>
					<Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
						Cancel
					</Button>
					<Button type="submit" disabled={pending || kind === "plays" && !target}>
						{pending ? "Applying…" : "Apply"}
					</Button>
				</DialogFooter>
			</form>
		</DialogContent>
	</Dialog>;
}
