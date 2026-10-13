import { useQuery } from "@tanstack/react-query";
import { Coins } from "lucide-react";
import { api, Button, foundOrNull, notFoundOutcome, requestOutcome, type BoxClientDefinition, type ConversationSummary, type MoveStaging } from "@/box-sdk/client";
import { boxMovesOf } from "@/box-sdk/shared";
import { tipMove, tipRecord } from "./shared";
import descriptor from "./shared-descriptor";
import "./tip-jar.css";

/** @approved A dynamic import, which `box:build` inlines: the server serves a Box only its `client.js` and `client.css`. */
const { dropCoin } = await import("./client-drop");

const useTipJar = (conversation: ConversationSummary) => useQuery({
	queryKey: ["tip-jar", conversation.id, conversation.revision],
	queryFn: async ({ signal }) => foundOrNull(await requestOutcome(
		api.api.conversations({ id: conversation.id }).boxes({ box: "tip-jar" }).get({ fetch: { signal } }), tipRecord, notFoundOutcome,
	)),
});

function TipJarDockTab({ conversation, onRestore }: { conversation: ConversationSummary; onRestore: () => void }) {
	const coins = useTipJar(conversation).data?.coins;
	return <button type="button" className="box-dock-tab" title="Restore Tip Jar" onClick={onRestore}>
		<Coins aria-hidden="true" /><span className="sr-only">Tip Jar: </span><span>{coins === undefined ? "…" : `${coins} coins`}</span>
	</button>;
}

function TipJarPanel({ conversation, disabled, staging }: { conversation: ConversationSummary; disabled: boolean; staging: MoveStaging | null }) {
	const coins = useTipJar(conversation).data?.coins;
	const staged = staging === null ? [] : boxMovesOf(staging.moves, "tip-jar", tipMove);
	return <div className="tip-jar">
		<output aria-label="Coins in the jar">{coins ?? "…"}</output>
		<Button disabled={disabled || staging === null || staged.length > 0} onClick={() => { if (staging !== null) dropCoin(staging); }}>Drop a coin</Button>
	</div>;
}

export default { descriptor, icon: Coins, Window: { size: { width: 18, height: 12 }, DockTab: TipJarDockTab, Panel: TipJarPanel } } satisfies BoxClientDefinition;
