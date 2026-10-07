import { ChevronDown, Ellipsis, Search } from "lucide-react";
import { Collapsible } from "radix-ui";
import { Fragment, useDeferredValue, useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { MemoryIdentity } from "../../shared/contract/memory";
import type { Portrait as PortraitImage } from "../../shared/contract/image";
import type { ConversationMemories } from "../memories";
import { PanelHeader } from "../PanelHeader";
import { Portrait } from "../story/Portrait";
import { MemoryAllowancePopover } from "./MemoryAllowancePopover";
import { MemoryCoverage } from "./MemoryCoverage";
import { MemoryLabelMergeDialog } from "./MemoryLabelMergeDialog";
import { MemoryIdentityDialog } from "./MemoryIdentityDialog";
import { MemoryNoteDialog } from "./MemoryNoteDialog";
import { MemoryClaimRow, MemorySourceCard } from "./MemorySource";
import { useConversationMemories } from "./useConversationMemories";

type Source = ConversationMemories["sources"][number];
type Entry = { source: Source; index: number };
type CastMember = { id: number; name: string; portrait?: PortraitImage };

export function MemoriesPanel({ conversationId, conversationRevision, cast, focusRequest, onClose, onNavigateSource, onOpenPanel }: {
	conversationId: number;
	conversationRevision: number;
	cast: CastMember[];
	focusRequest: { messageId: number } | null;
	onClose: () => void;
	onNavigateSource: (messageId: number) => void;
	onOpenPanel: (panel: "memory" | "prompts") => void;
}) {
	const {
		status, memories, catchup, settings, notice, busy, catchupBusy, editing, resetTarget,
		actions, refresh, settingsSaved, startCatchup, cancelCatchup, confirmReset, cancelReset,
		labelsMerged, identitySaved,
	} = useConversationMemories(conversationId, conversationRevision);
	const [query, setQuery] = useState("");
	const [focus, setFocus] = useState<number | null>(null);
	useEffect(() => { setFocus(focusRequest?.messageId ?? null); }, [focusRequest]);
	const [merging, setMerging] = useState<string[] | null>(null);
	const [identityTarget, setIdentityTarget] = useState<{ participant: CastMember; kind: MemoryIdentity["kind"] } | null>(null);
	const [noteOpen, setNoteOpen] = useState(false);
	const [alternativesOpen, setAlternativesOpen] = useState(false);

	const position = new Map(memories?.path.map((entry, index) => [entry.messageId, index]));
	const selected = memories?.sources.filter((source) => source.selected) ?? [];
	const alternatives = memories?.sources.filter((source) => !source.selected) ?? [];
	const awaitingEmbedding = selected.filter((source) => source.indexing.status === "unconfigured").length;
	const needle = useDeferredValue(query).trim().toLowerCase();
	const memoryCast = cast.map((participant) => ({ ...participant, names: memories?.cast.find(({ id }) => id === participant.id)?.names ?? [] }));
	const entries = (sources: Source[]) => sources
		.filter((source) => focus === null || source.messageId === focus)
		.sort((a, b) => (position.get(b.messageId) ?? -1) - (position.get(a.messageId) ?? -1))
		.flatMap((source) =>
			source.claims.flatMap((claim, index) =>
				!needle ||
				[claim.claim, claim.attribution, ...claim.people].some((text) => text.toLowerCase().includes(needle))
					? [{ source, index }]
					: []
			)
		);
	const rank = (name: string) => memoryCast.findIndex((participant) => participant.names.includes(name)) >>> 0;
	const byPeople = (list: Entry[]) => {
		const groups = new Map<string, { people: string[]; entries: Entry[] }>();
		for (const entry of list) {
			const people = [...new Set(entry.source.claims[entry.index]!.people)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
			const key = JSON.stringify(people);
			if (groups.has(key)) groups.get(key)!.entries.push(entry); else groups.set(key, { people, entries: [entry] });
		}
		const order = ({ people }: { people: string[] }) => people.length ? rank(people[0]!) : Infinity;
		return [...groups].sort(([a, x], [b, y]) => order(x) - order(y) || x.people.length - y.people.length || y.entries.length - x.entries.length || a.localeCompare(b));
	};
	const select = (messageId: number) => { setFocus(focus === messageId ? null : messageId); if (focus !== messageId) onNavigateSource(messageId); };
	const render = (list: Entry[]) =>
		byPeople(list).map(([key, { people, entries: group }]) => (
			<PeopleGroup
				key={key}
				people={people}
				cast={memoryCast}
				entries={group}
				cap={needle !== "" || focus !== null ? 20 : 6}
				onMerge={(person) => setMerging([person])}
				onIdentity={(participant, kind) => setIdentityTarget({ participant, kind })}
			>
		{({ source, index }) => <MemoryClaimRow
			key={`${source.variantId}:${index}`}
			source={source}
			index={index}
			group={people.join(" & ")}
			busy={busy.has(source.variantId)}
			editing={editing?.variantId === source.variantId && editing.index === index}
			actions={actions}
			onSelectSource={(target) => target.selected ? select(target.messageId) : onNavigateSource(target.messageId)}
			onNavigate={onNavigateSource}
		/>}
	</PeopleGroup>
		)
	);
	const visible = entries(selected);
	const hidden = alternativesOpen ? entries(alternatives) : [];
	const alternativeCount = alternatives.reduce((total, source) => total + source.claims.length, 0);
	const hasPeople = memories?.sources.some((source) => source.claims.some((claim) => claim.people.length > 0)) ?? false;

	return <aside className="details-panel" data-open="true" aria-label="Memories">
		<PanelHeader title="Memories" onClose={onClose} actions={<>
			{settings && <MemoryAllowancePopover conversationId={conversationId} settings={settings} onSaved={settingsSaved} />}
			<DropdownMenu>
				<DropdownMenuTrigger asChild><button type="button" className="icon-button" aria-label="More Memory actions"><Ellipsis aria-hidden="true" /></button></DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="min-w-44">
					<DropdownMenuItem disabled={!hasPeople} onSelect={() => setMerging([])}>Merge labels…</DropdownMenuItem>
					<DropdownMenuItem onSelect={() => setNoteOpen(true)}>Memory note…</DropdownMenuItem>
					<DropdownMenuItem onSelect={() => onOpenPanel("memory")}>Memory Settings</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</>} />
		<div className="panel-body memory-panel-body">
			{status === "failed" && (
				<div className="memory-callout" role="alert">
					<p>Memories could not be loaded.</p>
					<Button type="button" size="xs" variant="outline" onClick={() => void refresh()}>Try again</Button>
				</div>
			)}
			{status === "stale" && (
				<div className="memory-callout" role="status">
					<p>Could not refresh Memories. Showing the last loaded view.</p>
					<Button type="button" size="xs" variant="outline" onClick={() => void refresh()}>Try again</Button>
				</div>
			)}
			{status === "loading" && <div className="memory-loading" aria-label="Loading Memories"><span /><span /><span /><span /></div>}
			{memories !== null && <>
				{settings?.enabled === false && (
					<div className="memory-callout">
						<p>Memory is off for this Chat. Add a Memory Block to its Prompt Preset to start remembering. Saved Memories stay here.</p>
						<Button type="button" size="xs" variant="outline" onClick={() => onOpenPanel("prompts")}>Open Prompt Presets</Button>
					</div>
				)}
				{awaitingEmbedding > 0 && (
					<div className="memory-callout">
						<p>
							{awaitingEmbedding} {awaitingEmbedding === 1 ? "Message is" : "Messages are"} waiting for embedding
							settings before their Memories can be recalled.
						</p>
						<Button type="button" size="xs" variant="outline" onClick={() => onOpenPanel("memory")}>Memory Settings</Button>
					</div>
				)}
				{memories.path.length > 0 && (
					<MemoryCoverage
						path={memories.path}
						sources={new Map(selected.map((source) => [source.messageId, source]))}
						catchup={catchup}
						enabled={settings?.enabled ?? false}
						busy={catchupBusy}
						selected={focus}
						label={actions.label}
						onStart={() => void startCatchup()}
						onCancel={() => void cancelCatchup()}
						onSelect={select}
					/>
				)}
				{focus !== null && <MemorySourceCard
					conversationId={conversationId}
					source={selected.find((source) => source.messageId === focus)}
					label={actions.label(focus)}
					busy={busy.has(selected.find((source) => source.messageId === focus)?.variantId ?? -1)}
					enabled={settings?.enabled ?? false}
					excluded={memories.identities[memories.path.find((entry) => entry.messageId === focus)?.authorParticipantId ?? -1]?.kind === "excluded"}
					actions={actions}
					onNavigate={() => onNavigateSource(focus)}
					onStep={
						memories.path.length > 1
							? (offset) => {
							const next =
								memories.path[Math.min(memories.path.length - 1, Math.max(0, (position.get(focus) ?? 0) + offset))]!
									.messageId;
							setFocus(next);
							onNavigateSource(next);
										}
							: null
						}
					onClear={() => setFocus(null)}
				/>}
				{notice && <p className="import-problem" role="alert">{notice}</p>}
				{memories.sources.some((source) => source.claims.length > 0) && (
					<label className="search-field">
						<Search aria-hidden="true" />
						<input
							type="search"
							placeholder="Search Memories"
							aria-label="Search Memories"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
						/>
					</label>
				)}
				{visible.length > 0 ? (
					<div className="memory-list">{render(visible)}</div>
				) : (
					<p className="memory-empty">
						{memories.path.length === 0
							? "Memories appear here once the story has saved Messages."
							: needle
								? "No Memories match this search."
								: focus !== null
									? "No Memories from this Message."
									: "Nothing remembered yet."}
					</p>
				)}
				{alternativeCount > 0 && <details className="memory-alternatives" onToggle={(event) => setAlternativesOpen(event.currentTarget.open)}>
					<summary>Unselected alternatives · {alternativeCount}</summary>
					<p className="memory-empty">These Memories stay saved with their Swipes and return if one is selected again.</p>
					<div className="memory-list">{render(hidden)}</div>
				</details>}
			</>}
		</div>
		{merging && memories && (
			<MemoryLabelMergeDialog
				conversationId={conversationId}
				memories={memories}
				initialLabels={merging}
				onClose={() => setMerging(null)}
				onMerged={(updated, destination) => {
					labelsMerged(updated, destination);
					setMerging(null);
				}}
			/>
		)}
		{identityTarget && memories && (
			<MemoryIdentityDialog
				conversationId={conversationId}
				participant={identityTarget.participant}
				memories={memories}
				initialKind={identityTarget.kind}
				onClose={() => setIdentityTarget(null)}
				onSaved={(updated) => {
					void identitySaved(updated);
					setIdentityTarget(null);
				}}
			/>
		)}
		{noteOpen && settings && <MemoryNoteDialog conversationId={conversationId} settings={settings} onClose={() => setNoteOpen(false)} onSettings={settingsSaved} onSaved={() => setNoteOpen(false)} />}
		<Dialog open={resetTarget !== null} onOpenChange={(open) => { if (!open) cancelReset(); }}>
			<DialogContent showCloseButton={false} className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>Reset and re-extract?</DialogTitle>
					<DialogDescription>
						This discards every saved correction for {resetTarget ? actions.label(resetTarget.messageId) : "this source"} and
						resumes automatic updates. Its Memories are extracted again from the current Message.
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button type="button" variant="ghost" onClick={cancelReset}>Keep corrections</Button>
					<Button type="button" variant="destructive" onClick={confirmReset}>Reset and re-extract</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	</aside>;
}

function PeopleGroup({
	people,
	cast,
	entries,
	cap,
	onMerge,
	onIdentity,
	children,
}: {
	people: string[];
	cast: (CastMember & { names: string[] })[];
	entries: Entry[];
	cap: number;
	onMerge: (person: string) => void;
	onIdentity: (participant: CastMember, kind: MemoryIdentity["kind"]) => void;
	children: (entry: Entry) => ReactNode;
}) {
	const [more, setMore] = useState(0);
	const shown = (entries.length <= cap + 3 ? entries.length : cap) + more;
	const name = people.length ? people.join(" & ") : "Unlabelled";
	const participants = cast.filter((participant) => participant.names.some((name) => people.includes(name)));
	return <Collapsible.Root defaultOpen asChild><section className="memory-person" aria-label={name}>
		<header className="memory-person-header">
			<Collapsible.Trigger className="memory-person-trigger group">
				{people.length > 0 && (
					<span className="memory-person-portraits">
						{people.slice(0, 3).map((person) => (
							<Portrait
								key={person}
								name={person}
								size="small"
								portrait={cast.find((participant) => participant.names.includes(person))?.portrait}
							/>
						))}
					</span>
				)}
				<span className="memory-person-name">{name}</span>
				<span className="memory-person-count">{entries.length}</span>
				<ChevronDown className="size-3.5 shrink-0 group-data-[state=closed]:-rotate-90" aria-hidden="true" />
			</Collapsible.Trigger>
			{people.length > 0 && <DropdownMenu>
				<DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="icon-xs" aria-label={`Actions for ${name}`}><Ellipsis aria-hidden="true" /></Button></DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="min-w-44">
					{people.map((person) => <DropdownMenuItem key={person} onSelect={() => onMerge(person)}>Rename or merge {person}…</DropdownMenuItem>)}
					{participants.length > 0 && <DropdownMenuSeparator />}
					{participants.map((participant) => (
						<Fragment key={participant.id}>
							<DropdownMenuItem onSelect={() => onIdentity(participant, "excluded")}>
								{participant.name} isn't in the story…
							</DropdownMenuItem>
							<DropdownMenuItem onSelect={() => onIdentity(participant, "plays")}>
								{participant.name} plays…
							</DropdownMenuItem>
						</Fragment>
					))}
				</DropdownMenuContent>
			</DropdownMenu>}
		</header>
		<Collapsible.Content className="grid gap-[0.1rem]">
			{entries.slice(0, shown).map(children)}
			{entries.length > shown && (
				<Button
					type="button"
					size="xs"
					variant="ghost"
					className="justify-self-start"
					onClick={() => setMore(more + 50)}
				>
					Show {Math.min(50, entries.length - shown)} older
				</Button>
			)}
		</Collapsible.Content>
	</section></Collapsible.Root>;
}
