import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, type PortraitImage, type BoxInspectorProps, PanelHeader, Portrait } from "@/box-sdk/client";
import { ChevronDown, Ellipsis, Search } from "lucide-react";
import { Collapsible } from "radix-ui";
import { Fragment, useDeferredValue, useEffect, useState, type ReactNode } from "react";
import type { MemoryIdentity, ConversationMemories } from "./contract";
import { MemoryAllowancePopover } from "./client-allowance";
import { MemoryCoverage } from "./client-coverage";
import { MemoryLabelMergeDialog } from "./client-label-merge-dialog";
import { MemoryIdentityDialog } from "./client-identity-dialog";
import { MemoryNoteDialog } from "./client-note-dialog";
import { MemoryClaimRow, MemorySourceCard } from "./client-source";
import { groupEntriesByPeople, memoryCastMembers, memoryEntries, memoryPositions, type MemoryEntry } from "./client-view";
import { useConversationMemories, useMemoryActions } from "./client-use-memories";

type Source = ConversationMemories["sources"][number];
type CastMember = { id: number; name: string; portrait?: PortraitImage };

export function MemoriesPanel({ conversation, onConversationChange, focusRequest, onClose, onNavigateSource, onOpenSettings, onOpenConnections }: BoxInspectorProps) {
	const conversationId = conversation.id;
	const { status, memories, stored, settings, refresh, settingsSaved, labelsMerged, identitySaved } = useConversationMemories(conversationId, conversation.revision, { poll: true });
	const actions = useMemoryActions({ conversationId, conversation, onConversationChange, stored, refresh });
	const { notice, busy, catchupBusy, editing, resetTarget } = actions;
	const [query, setQuery] = useState("");
	const [focus, setFocus] = useState<number | null>(null);
	useEffect(() => { setFocus(focusRequest?.messageId ?? null); }, [focusRequest]);
	const [merging, setMerging] = useState<string[] | null>(null);
	const [identityTarget, setIdentityTarget] = useState<{ participant: CastMember; kind: MemoryIdentity["kind"] } | null>(null);
	const [noteOpen, setNoteOpen] = useState(false);
	const [alternativesOpen, setAlternativesOpen] = useState(false);

	const labels = new Map(memories?.path.map((entry, index) => [entry.messageId, `${entry.author ?? "Unknown author"} · #${index + 1}`]));
	const label = (messageId: number) => labels.get(messageId) ?? "Earlier Message";
	const position = memoryPositions(memories?.path ?? []);
	const selected = memories?.sources.filter((source) => source.selected) ?? [];
	const alternatives = memories?.sources.filter((source) => !source.selected) ?? [];
	const search = useDeferredValue(query);
	const searching = search.trim() !== "";
	const memoryCast = memoryCastMembers(conversation.cast, memories);
	const entries = (sources: Source[]) => memoryEntries(sources, position, focus, search);
	const select = (messageId: number) => { setFocus(focus === messageId ? null : messageId); if (focus !== messageId) onNavigateSource(messageId); };
	const ready = memories?.digestReady === true;
	const render = (list: MemoryEntry[]) =>
		groupEntriesByPeople(list, memoryCast).map(({ key, people, entries: group }) => (
			<PeopleGroup
				key={key}
				people={people}
				cast={memoryCast}
				entries={group}
				cap={searching || focus !== null ? 20 : 6}
				onMerge={(person) => setMerging([person])}
				onIdentity={(participant, kind) => setIdentityTarget({ participant, kind })}
			>
		{({ source, index }) => <MemoryClaimRow
			key={`${source.variantId}:${index}`}
			source={source}
			index={index}
			group={people.join(" & ")}
			busy={busy.has(source.variantId)}
			editing={editing?.variantId === source.variantId && editing.index === index ? editing.claims[index] ?? null : null}
			actions={{ ...actions, label }}
			onSelectSource={(target) => target.selected ? select(target.messageId) : onNavigateSource(target.messageId)}
			onNavigate={onNavigateSource}
		/>}
	</PeopleGroup>
		)
	);
	const visible = entries(selected);
	const hidden = alternativesOpen ? entries(alternatives) : [];
	const alternativeCount = alternatives.reduce((total, source) => total + (source.claims?.length ?? 0), 0);
	const hasClaims = memories?.sources.some((source) => (source.claims?.length ?? 0) > 0) ?? false;
	const hasPeople = memories?.sources.some((source) => source.claims?.some((claim) => claim.people.length > 0)) ?? false;
	const focused = selected.find((source) => source.messageId === focus);

	return <aside className="details-panel" data-open="true" aria-label="Memories">
		<PanelHeader title="Memories" onClose={onClose} actions={<>
			{settings && <MemoryAllowancePopover conversationId={conversationId} settings={settings} onSaved={settingsSaved} />}
			<DropdownMenu>
				<DropdownMenuTrigger asChild><button type="button" className="icon-button" aria-label="More Memory actions"><Ellipsis aria-hidden="true" /></button></DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="min-w-44">
					<DropdownMenuItem disabled={!hasPeople} onSelect={() => setMerging([])}>Merge labels…</DropdownMenuItem>
					<DropdownMenuItem onSelect={() => setNoteOpen(true)}>Memory note…</DropdownMenuItem>
					<DropdownMenuItem onSelect={onOpenSettings}>Memory Settings</DropdownMenuItem>
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
				{!memories.digestReady && (
					<div className="memory-callout">
						<p>Choose a Memory Decision Model before Messages can be remembered.</p>
						<Button type="button" size="xs" variant="outline" onClick={onOpenConnections}>Connections</Button>
					</div>
				)}
				{hasClaims && !memories.embeddingReady && (
					<div className="memory-callout">
						<p>Choose an embedding model before these Memories can be recalled.</p>
						<Button type="button" size="xs" variant="outline" onClick={onOpenSettings}>Memory Settings</Button>
					</div>
				)}
				{memories.path.length > 0 && (
					<MemoryCoverage
						path={memories.path}
						sources={new Map(selected.map((source) => [source.messageId, source]))}
						catchup={memories.catchUp}
						enabled={ready}
						busy={catchupBusy}
						selected={focus}
						label={label}
						onStart={() => void actions.startCatchup()}
						onCancel={() => void actions.cancelCatchup()}
						onSelect={select}
					/>
				)}
				{focus !== null && <MemorySourceCard
					source={focused}
					label={label(focus)}
					busy={busy.has(focused?.variantId ?? -1)}
					ready={ready}
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
				{hasClaims && (
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
							: searching
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
					void labelsMerged(updated);
					actions.announce(`Labels merged into ${destination}.`);
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
					actions.announce(null);
					setIdentityTarget(null);
				}}
			/>
		)}
		{noteOpen && settings && <MemoryNoteDialog conversationId={conversationId} settings={settings} onClose={() => setNoteOpen(false)} onSettings={settingsSaved} onSaved={() => setNoteOpen(false)} />}
		<Dialog open={resetTarget !== null} onOpenChange={(open) => { if (!open) actions.cancelReset(); }}>
			<DialogContent showCloseButton={false} className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>Reset corrections?</DialogTitle>
					<DialogDescription>
						This discards every saved correction for {resetTarget ? label(resetTarget.messageId) : "this source"}. The
						Memories remembered automatically from it come back.
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button type="button" variant="ghost" onClick={actions.cancelReset}>Keep corrections</Button>
					<Button type="button" variant="destructive" onClick={actions.confirmReset}>Reset corrections</Button>
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
	entries: MemoryEntry[];
	cap: number;
	onMerge: (person: string) => void;
	onIdentity: (participant: CastMember, kind: MemoryIdentity["kind"]) => void;
	children: (entry: MemoryEntry) => ReactNode;
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
