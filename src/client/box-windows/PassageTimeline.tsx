import { KindGuard, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, type LucideIcon } from "lucide-react";
import { useState, type ComponentProps, type ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { boxMetadata, boxRecordSchema, type BoxDescriptor, type BoxId, type BoxRecord } from "../../shared/contract/box";
import type { BoxValue } from "../../shared/contract/box-value";
import type { ConversationAction, ConversationSummary } from "../conversation";
import { CONVERSATION_UNREACHABLE_NOTICE, runConversationCommand } from "../conversation-command-runner";
import { useSaveGuard } from "../SaveGuard";
import { cancelBoxCatchUp, loadBoxDigest, loadBoxDigestStatus, startBoxCatchUp, type BoxDigest, type BoxDigestPassage } from "../box-digest";
import type { BoxWindowDefinition } from "./registry";
import { followsChanges } from "../server-changes";

export const boxDigestKey = (conversationId: number, box: BoxId) => ["box-digest", conversationId, box] as const;

/** @approved The window's read: a digest that lands while it is open, or a
 *  catch-up step, is a database change, and that revalidates the timeline. */
function useBoxDigest(conversationId: number, box: BoxId) {
	return useQuery({
		queryKey: boxDigestKey(conversationId, box),
		queryFn: ({ signal }) => loadBoxDigest(conversationId, box, signal),
		meta: followsChanges,
	});
}

// @approved
//  A digesting Box's folded status line, revalidated on each database change;
//  the label stands in for a null status. The host's dock button, header item
//  and Box manager row read it. Its key extends the digest's, so a save that
//  refreshes the timeline refreshes the status too.
export function useBoxStatus(conversationId: number, box: BoxId): string {
	const read = useQuery({
		queryKey: [...boxDigestKey(conversationId, box), "status"],
		queryFn: ({ signal }) => loadBoxDigestStatus(conversationId, box, signal),
		meta: followsChanges,
	});
	return read.data ?? (read.isError ? "Unavailable" : read.isSuccess ? boxMetadata(box).label : "Reading…");
}

/** @approved A record field holds a scalar: a literal, a number, a string or null. */
type FieldValue = string | number | boolean | null;
type Option = { readonly value: FieldValue; readonly label: string };
type RecordField = { readonly key: string; readonly label: string } & (
	| { readonly kind: "choice"; readonly options: readonly Option[] }
	| { readonly kind: "number"; readonly minimum?: number; readonly maximum?: number }
	| { readonly kind: "text" });

// @approved
//  The override editor is built from the Box's record schema: a union of
// literals (and null) is a choice, a number or integer is a number input, a
// string is a text input. Each schema's `title` labels its field or option.
const recordField = (key: string, schema: TSchema): RecordField => {
	const label: string = schema.title ?? key;
	if (KindGuard.IsOptional(schema)) throw new Error(`A passage timeline cannot edit the optional record field "${key}"; give it a union of literals with null instead.`);
	if (KindGuard.IsUnion(schema) && schema.anyOf.every((option) => KindGuard.IsLiteral(option) || KindGuard.IsNull(option))) {
		return { key, label, kind: "choice", options: schema.anyOf.map((option) => {
			const value = KindGuard.IsLiteral(option) ? option.const : null;
			return { value, label: option.title ?? (value === null ? "None" : String(value)) };
		}) };
	}
	if (KindGuard.IsInteger(schema) || KindGuard.IsNumber(schema)) return { key, label, kind: "number", minimum: schema.minimum, maximum: schema.maximum };
	if (KindGuard.IsString(schema)) return { key, label, kind: "text" };
	throw new Error(`A passage timeline cannot edit the record field "${key}".`);
};
const recordFields = ({ id, record }: BoxDescriptor): readonly RecordField[] => {
	if (record === undefined) throw new Error(`The ${id} Box keeps no records for a passage timeline.`);
	return Object.entries(record.properties).map(([key, schema]) => recordField(key, schema));
};

//  A digesting Box's window and status: its own Panel, if it has one, then the
// host's passage timeline, and its folded `status` line. `describe` summarizes
// a record on the timeline in place of the generic summary. The override
// editor is built from the record schema here, so a schema the timeline
// cannot edit fails the Box's client module as it loads, not when it opens.
export function digestWindow<Rec>(descriptor: BoxDescriptor, { icon, size, Panel, describe }: {
	icon: LucideIcon;
	size: BoxWindowDefinition["size"];
	Panel?: BoxWindowDefinition["Panel"];
	describe?(record: Rec): string;
}) {
	const { id: box } = descriptor;
	const fields = recordFields(descriptor);
	// @approved
	// SAFETY: the timeline holds this Box's records, which its `describe` takes.
	const summarize = (describe ?? ((record) => summaryOf(fields, record))) as (record: RecordValue) => string;
	const Status = ({ conversation }: { conversation: ConversationSummary }) => useBoxStatus(conversation.id, box);
	return {
		icon,
		Status,
		Window: {
			size,
			Panel: (props: ComponentProps<BoxWindowDefinition["Panel"]>) => <>
				{Panel !== undefined && <Panel {...props} />}
				<PassageTimeline box={box} fields={fields} summarize={summarize} conversation={props.conversation} disabled={props.disabled} onConversationChange={props.onConversationChange} />
			</>,
		},
	};
}

type RecordValue = BoxRecord;
const fieldValues = (record: RecordValue | null): ReadonlyMap<string, BoxValue> => new Map(record === null ? [] : Object.entries(record));
/** @approved The record the editor's fields hold; the record schema checks it before it is saved. */
type RecordCandidate = Readonly<Record<string, FieldValue | undefined>>;
/** @approved A choice holds its option's index, because Radix Select values must be non-empty strings. */
type Draft = Readonly<Record<string, string>>;

const draftOf = (fields: readonly RecordField[], record: RecordValue | null): Draft => Object.fromEntries(fields.map((field) => {
	const value = fieldValues(record).get(field.key) ?? null;
	if (field.kind === "choice") {
		const index = field.options.findIndex((option) => option.value === value);
		return [field.key, index === -1 ? "" : String(index)];
	}
	return [field.key, value === null ? "" : String(value)];
}));

const recordOf = (fields: readonly RecordField[], draft: Draft): RecordCandidate => Object.fromEntries(fields.map((field) => {
	const value = draft[field.key] ?? "";
	if (field.kind === "choice") return [field.key, value === "" ? undefined : field.options[Number(value)]?.value];
	if (field.kind === "number") return [field.key, value === "" ? undefined : Number(value)];
	return [field.key, value];
}));

/** @approved The record's one-line summary: each field's value, a choice as its option's label; a null field says nothing. */
const summaryOf = (fields: readonly RecordField[], record: RecordValue): string => fields.flatMap((field) => {
	const value = fieldValues(record).get(field.key) ?? null;
	if (value === null) return [];
	return [field.kind === "choice" ? field.options.find((option) => option.value === value)?.label ?? String(value) : String(value)];
}).join(" · ");

// @approved
//  The draft starts from `expected`, the record the editor replaces, which
// the editor names so a writer whose save was refused sees what is there now.
function RecordEditor({ box, passage, expected, fields, summarize, busy, onCancel, onSave }: {
	box: BoxId;
	passage: BoxDigestPassage;
	expected: RecordValue | null;
	fields: readonly RecordField[];
	summarize: (record: RecordValue) => string;
	busy: boolean;
	onCancel: () => void;
	onSave: (record: RecordValue) => Promise<boolean>;
}): ReactNode {
	const [baseline] = useState(() => draftOf(fields, expected));
	const [draft, setDraft] = useState(baseline);
	const [saving, setSaving] = useState(false);
	const record = recordOf(fields, draft);
	const valid = Value.Check(boxRecordSchema(box), record);
	const dirty = Object.keys(baseline).some((key) => draft[key] !== baseline[key]);
	const save = async () => {
		if (!valid || busy || saving) return false;
		setSaving(true);
		try { return await onSave(record); } finally { setSaving(false); }
	};
	useSaveGuard({ dirty, saving, save, discard: onCancel });
	const set = (key: string, value: string) => setDraft((current) => ({ ...current, [key]: value }));
	return <div className="box-timeline-editor">
		<p className="box-timeline-note">Replaces: {expected === null ? "Not read yet" : summarize(expected)}</p>
		{fields.map((field) => {
			const id = `${box}-${passage.variantId}-${field.key}`;
			if (field.kind === "choice") return <Field key={field.key} label={field.label}>
				<Select value={draft[field.key] ?? ""} disabled={busy} onValueChange={(value) => set(field.key, value)}>
					<SelectTrigger size="sm" aria-label={field.label}><SelectValue placeholder={`Choose ${field.label.toLowerCase()}`} /></SelectTrigger>
					<SelectContent>
						{field.options.map((option, index) => <SelectItem key={option.label} value={String(index)}>{option.label}</SelectItem>)}
					</SelectContent>
				</Select>
			</Field>;
			return <Field key={field.key} label={field.label} htmlFor={id}>
				<Input id={id} type={field.kind === "number" ? "number" : "text"} value={draft[field.key] ?? ""} disabled={busy}
					min={field.kind === "number" ? field.minimum : undefined} max={field.kind === "number" ? field.maximum : undefined}
					onChange={(event) => set(field.key, event.target.value)} />
			</Field>;
		})}
		<div className="box-timeline-actions">
			<Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>Cancel</Button>
			<Button size="sm" disabled={busy || !valid} onClick={() => void save()}>Save override</Button>
		</div>
	</div>;
}

const excerpt = (content: string) => content.replace(/<[^>]*>|[*_`~#>|]+|^-{3,}$/gm, "").replace(/\s+/g, " ").trim();

const commandNotices = { conflict: "The Chat changed elsewhere. Review the passage before saving again.", notFound: CONVERSATION_UNREACHABLE_NOTICE, unreachable: CONVERSATION_UNREACHABLE_NOTICE };

/** @approved Every digesting Box's window ends with this timeline of the
 *  Selected path's passages: each one's record, a Writer override editor
 *  built from the record schema, reset, and a catch-up run with its progress. */
function PassageTimeline({ box, fields, summarize, conversation, disabled, onConversationChange }: {
	box: BoxId;
	fields: readonly RecordField[];
	summarize: (record: RecordValue) => string;
	conversation: ConversationSummary;
	disabled: boolean;
	onConversationChange: (conversation: ConversationSummary) => void;
}): ReactNode {
	const client = useQueryClient();
	const read = useBoxDigest(conversation.id, box);
	const [editing, setEditing] = useState<{ readonly variantId: number; readonly expected: RecordValue | null } | null>(null);
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const locked = disabled || busy;
	const { label } = boxMetadata(box);
	const passages = read.data?.passages ?? [];
	const catchUp = read.data?.catchUp ?? null;
	const digestReady = read.data?.digestReady ?? false;
	const running = conversation.boxes[box] === "enabled";

	const apply = async (command: ConversationAction): Promise<boolean> => {
		let applied = false;
		setBusy(true);
		setNotice(null);
		try {
			await runConversationCommand({ conversationId: conversation.id, revision: () => conversation.revision, onConversationChange, setNotice }, command, {
				notices: commandNotices,
				onApplied: () => { applied = true; void client.invalidateQueries({ queryKey: boxDigestKey(conversation.id, box) }); },
			});
		} finally { setBusy(false); }
		return applied;
	};
	// @approved
	//  A refused save keeps the draft and moves `expected` to the record now
	// there, which the editor shows, so saving again overrides it knowingly.
	const save = async (passage: BoxDigestPassage, expected: RecordValue | null, record: RecordValue): Promise<boolean> => {
		if (locked) return false;
		if (await apply({ type: "set-box-record", box, messageId: passage.messageId, variantId: passage.variantId, record, expected })) {
			setEditing(null);
			return true;
		}
		const current = (await read.refetch()).data?.passages.find(({ variantId }) => variantId === passage.variantId);
		if (current !== undefined) setEditing((open) => open?.variantId === passage.variantId ? { ...open, expected: current.record } : open);
		return false;
	};
	const reset = (passage: BoxDigestPassage) => apply({ type: "reset-box-record", box, messageId: passage.messageId, variantId: passage.variantId });

	const runCatchUp = async (task: () => Promise<BoxDigest | null>) => {
		setBusy(true);
		setNotice(null);
		try {
			const result = await task();
			if (result === null) setNotice(CONVERSATION_UNREACHABLE_NOTICE);
			else client.setQueryData(boxDigestKey(conversation.id, box), result);
		} catch { setNotice(CONVERSATION_UNREACHABLE_NOTICE); } finally { setBusy(false); }
	};
	const missing = passages.some((passage) => !passage.digested);

	return <section aria-labelledby={`${box}-passages-title`} className="box-timeline">
		<div className="box-timeline-head">
			<h3 id={`${box}-passages-title`}>Passages</h3>
			{catchUp === null
				? <Button variant="outline" size="sm" disabled={locked || !running || !digestReady || !missing} onClick={() => void runCatchUp(() => startBoxCatchUp(conversation.id, box))}>
					Digest missing passages
				</Button>
				: <span className="box-timeline-progress" role="status">
					Digesting {catchUp.total - catchUp.remaining} of {catchUp.total}…{catchUp.failed > 0 && ` ${catchUp.failed} failed.`}
					<Button variant="ghost" size="sm" disabled={busy} onClick={() => void runCatchUp(() => cancelBoxCatchUp(conversation.id, box))}>Cancel</Button>
				</span>}
		</div>
		{!digestReady && <p className="box-timeline-note" role="status">Select a {label} Decision Model in Connection Settings to digest passages.</p>}
		{notice !== null && <Alert><AlertDescription>{notice}</AlertDescription></Alert>}
		{read.isError && <p role="alert">The {label} could not be read.</p>}
		{read.isSuccess && passages.length === 0 && <p className="box-timeline-note">No passages yet.</p>}
		<ol>
			{passages.map((passage) => (
				<li key={passage.variantId}>
					<strong>{passage.author ?? "Unknown"}</strong>
					<span className="box-timeline-text">{excerpt(passage.content)}</span>
					{editing?.variantId === passage.variantId
						? <RecordEditor box={box} passage={passage} expected={editing.expected} fields={fields} summarize={summarize} busy={locked}
							onCancel={() => setEditing(null)} onSave={(record) => save(passage, editing.expected, record)} />
						: <div className="box-timeline-read">
							<span className="box-timeline-summary">
								{passage.record === null ? <em>Not read yet</em> : summarize(passage.record)}
								{passage.overridden && <span className="box-timeline-override-mark">Overridden</span>}
								{passage.error !== null && <span className="box-timeline-error">Digest failed: {passage.error}</span>}
							</span>
							<span className="box-timeline-actions">
								<Button variant="ghost" size="sm" disabled={locked} onClick={() => setEditing({ variantId: passage.variantId, expected: passage.record })}><Pencil aria-hidden="true" />Edit</Button>
								{passage.overridden && <Button variant="ghost" size="sm" disabled={locked} onClick={() => void reset(passage)}>Reset</Button>}
							</span>
						</div>}
				</li>
			))}
		</ol>
	</section>;
}
