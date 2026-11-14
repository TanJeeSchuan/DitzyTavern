import { useContext, useId } from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useOpenImageAt } from "./ImageDialog";
import { IllustrationActionsContext, useGallery, usePaintingCommand } from "./painting";
import { imageSrc } from "./lib/image";
import type { GalleryRead } from "../shared/contract/painting";

export function PaintGallery({ conversationId, disabled, onReference, onUseBrief }: {
	conversationId: number;
	disabled: boolean;
	onReference: (name: string, hash: string) => void;
	onUseBrief: (name: string, painted: NonNullable<GalleryRead[number]["painted"]>) => void;
}) {
	const headingId = useId();
	const read = useGallery(conversationId);
	const actions = useContext(IllustrationActionsContext)!;
	const openImageAt = useOpenImageAt();
	const { submit, pending, error } = usePaintingCommand(conversationId);
	return <section className="grid min-w-0 gap-2" aria-labelledby={headingId}>
		<h3 id={headingId} className="text-sm font-medium">Gallery</h3>
		{read.isError ? <p role="alert" className="text-sm text-destructive">Gallery could not be loaded. <Button variant="ghost" size="sm" onClick={() => void read.refetch()}>Retry</Button></p>
			: read.isPending ? <div className="flex gap-3 overflow-hidden" aria-hidden="true">{[0, 1, 2].map((key) => <div key={key} className="grid w-32 shrink-0 gap-2">
				<div className="skeleton h-24 rounded-lg" /><div className="skeleton h-3 w-24 rounded" /><div className="skeleton h-3 w-16 rounded" />
			</div>)}</div>
				: read.data.length === 0 ? <p className="panel-note">Pictures from this Chat and its Cast appear here.</p>
					: <ul className="flex gap-3 overflow-x-auto p-1" role="list">
						{read.data.map(({ hash, name, source, keptId, painted }) => <li key={hash} className="grid w-32 shrink-0 content-start gap-1">
							<button type="button" className="prose-image paint-gallery-thumbnail" title="Insert into References"
								aria-label={`Use as reference: ${name}`} onClick={() => onReference(name, hash)}>
								<img src={imageSrc(hash)} alt={name} loading="lazy" />
							</button>
							<div className="flex min-w-0 items-start gap-1">
								<div className="min-w-0 flex-1 text-xs">
									<p className="truncate" title={name}>{name}</p>
									<p className="truncate text-muted-foreground" title={source}>{source}</p>
								</div>
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<Button size="icon-sm" variant="ghost" aria-label={`Picture actions: ${name}`} title="Picture actions"><MoreHorizontal aria-hidden="true" /></Button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end" className="w-auto">
										<DropdownMenuItem data-image-hash={hash} data-image-name={name} onSelect={(event) => { if (event.target) openImageAt(event.target); }}>Open full size</DropdownMenuItem>
										<DropdownMenuItem disabled={actions.addToComposer === null} onSelect={() => actions.addToComposer?.(name, hash)}>Add to composer</DropdownMenuItem>
										{painted !== undefined && <DropdownMenuItem disabled={disabled} onSelect={() => onUseBrief(name, painted)}>Use Brief</DropdownMenuItem>}
										{keptId !== undefined && <DropdownMenuItem variant="destructive" disabled={pending} onSelect={() => void submit({ type: "remove-from-gallery", id: keptId })}>Remove from Gallery</DropdownMenuItem>}
									</DropdownMenuContent>
								</DropdownMenu>
							</div>
						</li>)}
					</ul>}
		{error !== null && <p role="alert" className="text-sm text-destructive">{error}</p>}
	</section>;
}
