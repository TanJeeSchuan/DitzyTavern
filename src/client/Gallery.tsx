import { useContext, useRef, useState } from "react";
import { ImagePlus, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useOpenImageAt } from "./ImageDialog";
import { IllustrationActionsContext, useGallery, usePaintingCommand } from "./painting";
import { baseName, imageAccept, imageSrc, uploadImage } from "./lib/image";
import type { GalleryRead } from "../shared/contract/painting";

export function Gallery({ conversationId, paint }: {
	conversationId: number;
	paint?: {
		insertDisabled: boolean;
		adoptDisabled: boolean;
		onReference: (name: string, hash: string) => void;
		onUseBrief: (name: string, painted: NonNullable<GalleryRead[number]["painted"]>) => void;
	};
}) {
	const read = useGallery(conversationId);
	const actions = useContext(IllustrationActionsContext)!;
	const openImageAt = useOpenImageAt();
	const { submit, pending, error } = usePaintingCommand(conversationId);
	const picker = useRef<HTMLInputElement>(null);
	const [uploading, setUploading] = useState(false);
	const [uploadError, setUploadError] = useState<string | null>(null);
	const upload = async (files: File[]) => {
		setUploading(true);
		setUploadError(null);
		try {
			for (const file of files) if (!await submit({ type: "add-to-gallery", name: baseName(file.name), hash: (await uploadImage(file)).hash })) return;
		} catch (cause) {
			setUploadError(cause instanceof Error ? cause.message : "That file could not be read as an image.");
		} finally { setUploading(false); }
	};
	return <section className="grid min-w-0 gap-2" aria-label="Gallery">
		<div className="flex items-center justify-between gap-2">
			{paint && <h3 className="text-sm font-medium">Gallery</h3>}
			<Button size="sm" variant="ghost" disabled={uploading} onClick={() => picker.current?.click()}><ImagePlus aria-hidden="true" />{uploading ? "Uploading…" : "Upload"}</Button>
			<input ref={picker} type="file" accept={imageAccept} multiple className="sr-only" aria-label="Upload to Gallery" tabIndex={-1}
				onChange={(event) => { void upload([...(event.target.files ?? [])]); event.target.value = ""; }} />
		</div>
		{read.isError ? <p role="alert" className="text-sm text-destructive">Gallery could not be loaded. <Button variant="ghost" size="sm" onClick={() => void read.refetch()}>Retry</Button></p>
			: read.isPending ? <div className="flex gap-3 overflow-hidden" aria-hidden="true">{[0, 1, 2].map((key) => <div key={key} className="grid w-32 shrink-0 gap-2">
				<div className="skeleton h-24 rounded-lg" /><div className="skeleton h-3 w-24 rounded" /><div className="skeleton h-3 w-16 rounded" />
			</div>)}</div>
				: read.data.length === 0 ? <p className="panel-note">Pictures from this Chat and its Cast, and pictures you upload, appear here.</p>
					: <ul className={cn("gap-3 p-1", paint ? "flex overflow-x-auto" : "grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))]")} role="list">
						{read.data.map(({ hash, name, source, keptId, painted }) => <li key={hash} className={cn("grid content-start gap-1", paint && "w-32 shrink-0")}>
							<button type="button" className="prose-image gallery-thumbnail" disabled={paint?.insertDisabled} title={paint ? "Insert into References" : undefined}
								aria-label={paint ? `Use as reference: ${name}` : `Open ${name} full size`} data-image-hash={hash} data-image-name={name}
								onClick={(event) => paint ? paint.onReference(name, hash) : openImageAt(event.currentTarget)}>
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
										{paint && <DropdownMenuItem data-image-hash={hash} data-image-name={name} onSelect={(event) => { if (event.target) openImageAt(event.target); }}>Open full size</DropdownMenuItem>}
										<DropdownMenuItem disabled={actions.addToComposer === null} onSelect={() => actions.addToComposer?.(name, hash)}>Add to composer</DropdownMenuItem>
										{paint && painted !== undefined && <DropdownMenuItem disabled={paint.adoptDisabled} onSelect={() => paint.onUseBrief(name, painted)}>Use Brief</DropdownMenuItem>}
										{keptId !== undefined && <DropdownMenuItem variant="destructive" disabled={pending} onSelect={() => void submit({ type: "remove-from-gallery", id: keptId })}>Remove from Gallery</DropdownMenuItem>}
									</DropdownMenuContent>
								</DropdownMenu>
							</div>
						</li>)}
					</ul>}
		{(uploadError ?? error) !== null && <p role="alert" className="text-sm text-destructive">{uploadError ?? error}</p>}
	</section>;
}
