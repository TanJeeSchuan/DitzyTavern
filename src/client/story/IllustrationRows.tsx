import { useContext } from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { IllustrationActionsContext, useIllustrations, usePaintingCommand } from "../painting";
import { useOpenImageAt } from "../ImageDialog";
import { imageSrc } from "../lib/image";

export function IllustrationRows({ conversationId, variantId }: { conversationId: number; variantId: number }) {
	const { data } = useIllustrations(conversationId, variantId);
	const { submit, pending, error } = usePaintingCommand(conversationId);
	const actions = useContext(IllustrationActionsContext)!;
	const openImageAt = useOpenImageAt();
	return <>
		{data?.paintings.map((painting) => <figure key={painting.id} className="illustration-row my-5 w-full overflow-hidden rounded-xl border border-border bg-muted/30" aria-label="Illustration">
			<div className="illustration-picture relative grid w-full overflow-hidden" style={{ aspectRatio: painting.aspectRatio.replace(":", "/") }}>
				{painting.kind === "illustration"
					? <button type="button" className="absolute inset-0 cursor-zoom-in rounded-t-xl focus-visible:outline-none"
						aria-label="Open Illustration full size"
						data-image-hash={painting.image.slice(6)} data-image-name="Illustration" onClick={(event) => openImageAt(event.currentTarget)}>
						<img src={imageSrc(painting.image.slice(6))} alt="Illustration" className="h-full w-full object-contain" />
					</button>
					: painting.kind === "painting" ? <p className="place-self-center text-sm text-muted-foreground" role="status">Painting…</p>
						: <p role="alert" className="place-self-center max-h-full overflow-auto p-4 text-sm text-destructive">{painting.message}</p>}
			</div>
			<figcaption className="illustration-actions flex items-center justify-end gap-2 px-2">
				{painting.kind === "illustration" && <>
					<Button size="sm" variant="ghost" disabled={actions.addToComposer === null} onClick={() => actions.addToComposer?.(painting.image.slice(6))}>Add to composer</Button>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button size="icon-sm" variant="ghost" aria-label="Illustration actions" title="Illustration actions"><MoreHorizontal aria-hidden="true" /></Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-auto">
							<DropdownMenuItem onSelect={() => actions.editBrief(variantId, painting.brief)}>Edit Brief and repaint</DropdownMenuItem>
							<DropdownMenuItem variant="destructive" disabled={pending} onSelect={() => void submit({ type: "delete", id: painting.id, variantId })}>Delete</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</>}
				{painting.kind === "failed" && <>
					<Button size="sm" variant="outline" disabled={pending} onClick={() => void submit({ type: "retry", id: painting.id, variantId })}>Retry</Button>
					<Button size="sm" variant="ghost" disabled={pending} onClick={() => void submit({ type: "dismiss", id: painting.id, variantId })}>Dismiss</Button>
				</>}
			</figcaption>
		</figure>)}
		{error !== null && <p role="alert" className="text-sm text-destructive">{error}</p>}
	</>;
}
