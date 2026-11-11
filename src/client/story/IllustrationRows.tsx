import { Button } from "@/components/ui/button";
import { useIllustrations, usePaintingCommand } from "../painting";
import { imageSrc } from "../lib/image";

export function IllustrationRows({ conversationId, variantId }: { conversationId: number; variantId: number }) {
	const { data } = useIllustrations(conversationId, variantId);
	const { submit, pending, error } = usePaintingCommand(conversationId);
	return <>
		{data?.paintings.map((painting) => <figure key={painting.id} className="my-5 grid w-full overflow-hidden rounded-xl border border-border bg-muted/30" aria-label="Illustration"
			style={{ aspectRatio: painting.aspectRatio.replace(":", "/"), maxHeight: "50dvh" }}>
			{painting.kind === "illustration"
				? <img src={imageSrc(painting.image.slice(6))} alt="Illustration" className="h-full min-h-0 w-full object-contain" />
				: painting.kind === "painting" ? <p className="place-self-center text-sm text-muted-foreground" role="status">Painting…</p>
					: <figcaption className="grid content-center justify-items-center gap-3 overflow-auto p-4">
						<p role="alert" className="text-sm text-destructive">{painting.message}</p>
						<div className="flex gap-2"><Button size="sm" variant="outline" disabled={pending} onClick={() => void submit({ type: "retry", id: painting.id, variantId })}>Retry</Button><Button size="sm" variant="ghost" disabled={pending} onClick={() => void submit({ type: "dismiss", id: painting.id, variantId })}>Dismiss</Button></div>
					</figcaption>}
		</figure>)}
		{error !== null && <p role="alert" className="text-sm text-destructive">{error}</p>}
	</>;
}
