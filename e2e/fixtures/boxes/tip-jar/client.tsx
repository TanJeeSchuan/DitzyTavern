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

function TipJarStatus({ conversation }: { conversation: ConversationSummary }) {
	const coins = useTipJar(conversation).data?.coins;
	return <span>{coins === undefined ? "…" : `${coins} coins`}</span>;
}

function TipJarPanel({ conversation, disabled, staging }: { conversation: ConversationSummary; disabled: boolean; staging: MoveStaging | null }) {
	const coins = useTipJar(conversation).data?.coins;
	const staged = staging === null ? [] : boxMovesOf(staging.moves, "tip-jar", tipMove);
	return <div className="tip-jar">
		<output aria-label="Coins in the jar">{coins ?? "…"}</output>
		<Button disabled={disabled || staging === null || staged.length > 0} onClick={() => { if (staging !== null) dropCoin(staging); }}>Drop a coin</Button>
	</div>;
}

export default { descriptor, icon: Coins, Status: TipJarStatus, Window: { size: { width: 18, height: 12 }, Panel: TipJarPanel } } satisfies BoxClientDefinition;
