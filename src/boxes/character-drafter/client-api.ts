import { useQuery } from "@tanstack/react-query";
import { Value } from "@sinclair/typebox/value";
import { createParser } from "eventsource-parser";
import { useEffect, useRef, useState } from "react";
import { boxApi, followsChanges, openDefinitionDraft, requestData, type ConversationSummary } from "@/box-sdk/client";
import type { CodeAgentActivity } from "@/box-sdk/shared";
import { draftEvent, drafterRead, draftRequestRefusal, type CharacterDraft, type DraftRequest } from "./contract";
import descriptor from "./shared-descriptor";
import type { DrafterRoutes } from "./server-routes";

const drafter = boxApi<DrafterRoutes>(descriptor.id);

// @approved
//  The people Memory knows in this Chat and why a draft cannot start. It
// follows every committed change, since Memory's digests and label edits and
// the delegate setting change it without a Chat revision; no command is sent
// at a revision it supplies.
export function useDrafterRead(conversation: ConversationSummary) {
	const read = useQuery({
		queryKey: ["box", descriptor.id, conversation.id],
		queryFn: ({ signal }) => requestData(drafter.conversations({ id: String(conversation.id) }).get({ fetch: { signal } }), drafterRead),
		meta: followsChanges,
	});
	const unavailable = conversation.boxes[descriptor.id] !== "enabled" ? "The Character Drafter is off in this Chat."
		: read.isError ? "Couldn't check the agent model. Check the Default delegate model in Connections."
		: read.isPending ? "Checking the agent model…" : read.data.unavailable;
	return { people: read.data?.people ?? [], unavailable };
}

/** @approved One draft as the writer watches it: the steps the agent ran, and how it ended once it has. */
export type DraftRun =
	| { readonly status: "idle" }
	| { readonly status: "running" | "cancelled"; readonly activities: readonly CodeAgentActivity[] }
	| { readonly status: "drafted"; readonly activities: readonly CodeAgentActivity[]; readonly draft: CharacterDraft }
	| { readonly status: "opened"; readonly activities: readonly CodeAgentActivity[]; readonly name: string }
	| { readonly status: "failed"; readonly activities: readonly CodeAgentActivity[]; readonly reason: string };

const activitiesOf = (run: DraftRun) => run.status === "idle" ? [] : run.activities;

/** @approved Why the server refused to start a draft: the failed check's summary for a request its schema rejects. */
const refusal = async (response: Response) => {
	const body: unknown = await response.json().catch(() => null);
	return Value.Check(draftRequestRefusal, body) ? `The draft could not start: ${body.summary}` : "The draft could not start. Try again.";
};

// @approved
//  Starts a draft and follows its stream: each step joins the feed, and the
// draft or the failure ends it. Cancelling, starting again or unmounting
// closes the stream, which cancels the run on the server; a closed stream's
// late frames have nowhere to land. Opening a draft hands it to the
// Definition editor and lets go of it here, so one draft is kept at most
// once and closing the editor discards it. With `opensOnDraft`, the draft
// opens as soon as it arrives.
export function useDraftRun({ conversationId, replaces, opensOnDraft = false }: { conversationId: number; replaces?: number; opensOnDraft?: boolean }) {
	const controller = useRef<AbortController | null>(null);
	const [run, setRun] = useState<DraftRun>({ status: "idle" });
	useEffect(() => () => controller.current?.abort(), []);
	const open = (draft: CharacterDraft) => {
		openDefinitionDraft(draft, { conversationId, replaces, onOpened: () => {
			setRun((current) => current.status === "drafted" && current.draft === draft
				? { status: "opened", activities: current.activities, name: draft.name } : current);
		} });
	};
	const start = async (request: DraftRequest) => {
		controller.current?.abort();
		const active = new AbortController();
		controller.current = active;
		const update = (next: (run: DraftRun) => DraftRun) => { if (controller.current === active) setRun(next); };
		setRun({ status: "running", activities: [] });
		let ended = false;
		try {
			const response = await fetch(`/api/boxes/${descriptor.id}/draft`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request), signal: active.signal });
			if (!response.ok) throw new Error(await refusal(response));
			if (response.body === null) throw new Error("The draft could not start. Try again.");
			const parser = createParser({ onEvent: ({ data }) => {
				const event: unknown = JSON.parse(data);
				if (!Value.Check(draftEvent, event)) throw new Error("The draft stream sent something unreadable. Try again.");
				if (event.type === "activity") return update((current) => ({ status: "running", activities: [...activitiesOf(current), event.activity] }));
				ended = true;
				if (event.type === "failed") return update((current) => ({ status: "failed", activities: activitiesOf(current), reason: event.message }));
				if (controller.current !== active) return;
				setRun((current) => ({ status: "drafted", activities: activitiesOf(current), draft: event.draft }));
				if (opensOnDraft) open(event.draft);
			} });
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			try {
				for (let next = await reader.read(); !next.done; next = await reader.read()) parser.feed(decoder.decode(next.value, { stream: true }));
			} finally { reader.releaseLock(); }
			if (!ended) throw new Error("The draft stream ended before the draft. Try again.");
		} catch (error) {
			if (!active.signal.aborted) update((current) => ({ status: "failed", activities: activitiesOf(current), reason: error instanceof Error ? error.message : String(error) }));
		} finally {
			if (controller.current === active) controller.current = null;
		}
	};
	const cancel = () => {
		controller.current?.abort();
		controller.current = null;
		setRun((current) => ({ status: "cancelled", activities: activitiesOf(current) }));
	};
	return { run, start, cancel, open };
}
