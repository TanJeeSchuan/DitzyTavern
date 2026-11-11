import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import type { Painting } from "../../shared/contract/painting";
import { commandPainting, illustrationsKey } from "../painting";
import { imageSrc } from "../lib/image";

export function IllustrationRows({ conversationId, paintings }: { conversationId: number; paintings: readonly Painting[] }) {
	const client = useQueryClient();
	const [pending, setPending] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const command = async (painting: Painting, type: "retry" | "dismiss") => {
		setPending(painting.id);
		setError(null);
		try {
			const result = await commandPainting(conversationId, { type, id: painting.id, variantId: painting.variantId });
			if (result.outcome === "available") await client.invalidateQueries({ queryKey: illustrationsKey(conversationId) });
			else setError(result.outcome === "invalid" || result.outcome === "unusable" ? result.reason : "The painting could not be updated.");
		} finally { setPending(null); }
	};
	return <>
		{paintings.map((painting) => <figure key={painting.id} className="my-5 grid w-full overflow-hidden rounded-xl border border-border bg-muted/30" aria-label="Illustration"
			style={{ aspectRatio: painting.aspectRatio.replace(":", "/"), maxHeight: "50dvh" }}>
			{painting.kind === "illustration"
				? <img src={imageSrc(painting.image.slice(6))} alt="Illustration" className="h-full min-h-0 w-full object-contain" />
				: painting.kind === "painting" ? <p className="place-self-center text-sm text-muted-foreground" role="status">Painting…</p>
					: <figcaption className="grid content-center justify-items-center gap-3 overflow-auto p-4">
						<p role="alert" className="text-sm text-destructive">{painting.message}</p>
						<div className="flex gap-2"><Button size="sm" variant="outline" disabled={pending !== null} onClick={() => void command(painting, "retry")}>Retry</Button><Button size="sm" variant="ghost" disabled={pending !== null} onClick={() => void command(painting, "dismiss")}>Dismiss</Button></div>
					</figcaption>}
		</figure>)}
		{error !== null && <p role="alert" className="text-sm text-destructive">{error}</p>}
	</>;
}
