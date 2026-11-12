import { useContext, useId } from "react";
import { Button } from "@/components/ui/button";
import { useOpenImageAt } from "./ImageDialog";
import { IllustrationActionsContext, useGallery } from "./painting";
import { imageSrc } from "./lib/image";

export function PaintGallery({ conversationId, disabled, onReference }: {
	conversationId: number;
	disabled: boolean;
	onReference: (name: string, hash: string) => void;
}) {
	const headingId = useId();
	const read = useGallery(conversationId);
	const actions = useContext(IllustrationActionsContext)!;
	const openImageAt = useOpenImageAt();
	return <section className="grid min-w-0 gap-2" aria-labelledby={headingId}>
		<h3 id={headingId} className="text-sm font-medium">Gallery</h3>
		{read.isError ? <p role="alert" className="text-sm text-destructive">Gallery could not be loaded. <Button variant="ghost" size="sm" onClick={() => void read.refetch()}>Retry</Button></p>
			: read.isPending ? <p className="panel-note">Loading pictures…</p>
				: read.data.length === 0 ? <p className="panel-note">Pictures from this Chat and its Cast appear here.</p>
					: <ul className="flex gap-3 overflow-x-auto pb-2" role="list">
						{read.data.map(({ hash, name }) => <li key={hash} className="grid w-36 shrink-0 content-start gap-1">
							<button type="button" className="h-24 w-full cursor-zoom-in overflow-hidden rounded-lg border border-border bg-muted/30 hover:border-primary focus-visible:outline-2 focus-visible:outline-ring"
								aria-label={`Open ${name} full size`} data-image-hash={hash} data-image-name={name} onClick={(event) => openImageAt(event.currentTarget)}>
								<img src={imageSrc(hash)} alt={name} loading="lazy" className="h-full w-full object-contain" />
							</button>
							<p className="truncate text-xs text-muted-foreground" title={name}>{name}</p>
							<Button size="sm" variant="ghost" className="justify-start px-1" aria-label={`Use as reference: ${name}`} disabled={disabled} onClick={() => onReference(name, hash)}>Use as reference</Button>
							<Button size="sm" variant="ghost" className="justify-start px-1" aria-label={`Add to composer: ${name}`} disabled={actions.addToComposer === null} onClick={() => actions.addToComposer?.(name, hash)}>Add to composer</Button>
						</li>)}
					</ul>}
	</section>;
}
