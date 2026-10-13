import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { useQuery } from "@tanstack/react-query";
import { Smartphone } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, SegmentedControl, Textarea, type ConversationSummary, type MoveStaging } from "@/box-sdk/client";
import { boxMovesOf } from "@/box-sdk/shared";
import { MAX_PHONE_MOVES, phoneMove, type PhoneRead } from "./contract";
import type { Sms } from "./shared";
import { loadPhone } from "./client-read";

const usePhone = (conversation: ConversationSummary) => useQuery({
	queryKey: ["phone", conversation.id, conversation.revision],
	queryFn: ({ signal }) => loadPhone(conversation.id, signal),
	placeholderData: (previous) => previous,
});

// @approved
//  Unread counts are client view state, never in the prompt: the keys of the
//  incoming texts this Chat's Phone has shown, kept per Chat in local storage.
const seenKeys = Type.Array(Type.String());
const seenStorageKey = (conversationId: number) => `ditzytavern.phone-seen.${conversationId}`;
const readSeen = (conversationId: number): Set<string> => {
	try {
		const parsed: unknown = JSON.parse(window.localStorage.getItem(seenStorageKey(conversationId)) ?? "[]");
		return new Set(Value.Check(seenKeys, parsed) ? parsed : []);
	} catch {
		return new Set();
	}
};
const unread = (thread: PhoneRead["threads"][number], seen: Set<string>) =>
	thread.texts.filter(({ from, key }) => from === thread.contact && !seen.has(key)).length;

export function PhoneDockTab({ conversation, onRestore }: { conversation: ConversationSummary; onRestore: () => void }) {
	const read = usePhone(conversation);
	const seen = readSeen(conversation.id);
	const count = read.data?.threads.reduce((total, thread) => total + unread(thread, seen), 0) ?? 0;
	return <button type="button" className="box-dock-tab" title="Restore Phone" onClick={onRestore}>
		<Smartphone aria-hidden="true" /><span className="sr-only">Phone: </span>
		<span>{read.isError ? "Unavailable" : count === 0 ? "No unread texts" : `${count} unread`}</span>
	</button>;
}

/** @approved A text the lens lifted out of the prose: the story keeps a mark where it was, which opens the Phone. */
export function PhoneLensView({ text, onOpen }: { text: Sms; onOpen: () => void }) {
	return <button type="button" className="phone-lens" onClick={onOpen}>
		<Smartphone aria-hidden="true" />{text.from} texted {text.to}
	</button>;
}

export function PhonePanel({ conversation, disabled, staging }: { conversation: ConversationSummary; disabled: boolean; staging: MoveStaging }) {
	const read = usePhone(conversation);
	const [seen, setSeen] = useState(() => readSeen(conversation.id));
	const [picked, setPicked] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const threads = read.data?.threads ?? [];
	const thread = threads.find(({ contact }) => contact === picked) ?? threads.find((candidate) => unread(candidate, seen) > 0) ?? threads[0];
	const staged = boxMovesOf(staging.moves, "phone", phoneMove);
	// @approved
	//  An open thread is a read thread, including texts that arrive while it
	//  is showing. The thread opened by default stays open once read.
	useEffect(() => {
		if (thread === undefined) return;
		if (picked === null) setPicked(thread.contact);
		if (unread(thread, seen) === 0) return;
		const next = new Set([...seen, ...thread.texts.map(({ key }) => key)]);
		window.localStorage.setItem(seenStorageKey(conversation.id), JSON.stringify([...next]));
		setSeen(next);
	}, [conversation.id, thread, seen, picked]);

	if (read.isError) return <p className="phone-note">The Phone could not be loaded.</p>;
	if (read.data === undefined || read.data === null) return null;
	const human = read.data.human;
	if (human === null) return <p className="phone-note">Choose who the writer plays to use the Phone.</p>;
	if (thread === undefined) return <p className="phone-note">Add another Cast member to text them.</p>;
	const pending = staged.filter(({ to }) => to === thread.contact);
	const stage = () => {
		const text = draft.trim();
		if (text === "" || staged.length >= MAX_PHONE_MOVES) return;
		staging.onChange({ ...staging.moves, phone: [...staged, { to: thread.contact, text }] });
		setDraft("");
	};
	return <div className="phone-window">
		{threads.length === 1 ? <h3 className="phone-contact">{thread.contact}</h3> : <SegmentedControl label="Contacts" value={thread.contact} onValueChange={setPicked}
			options={threads.map((candidate) => {
				const count = candidate === thread ? 0 : unread(candidate, seen);
				return { value: candidate.contact, label: <>{candidate.contact}{count > 0 && <small> {count} new</small>}</> };
			})} />}
		<ol className="phone-thread" aria-label={`Texts with ${thread.contact}`}>
			{thread.texts.map(({ key, from, text }) => <li key={key} data-outgoing={from === human || undefined}>{text}</li>)}
			{pending.map(({ text }, index) => <li key={`staged:${index}`} data-outgoing data-staged>{text}<small>Staged</small></li>)}
			{thread.texts.length + pending.length === 0 && <li className="phone-note">No texts with {thread.contact} yet.</li>}
		</ol>
		<form className="phone-compose" onSubmit={(event) => { event.preventDefault(); stage(); }}>
			<Textarea aria-label={`Text ${thread.contact}`} placeholder={`Text ${thread.contact}`} value={draft} maxLength={2000} disabled={disabled} rows={2}
				onChange={(event) => setDraft(event.target.value)}
				onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); stage(); } }} />
			<Button type="submit" size="sm" disabled={disabled || draft.trim() === "" || staged.length >= MAX_PHONE_MOVES}>Stage text</Button>
		</form>
	</div>;
}
