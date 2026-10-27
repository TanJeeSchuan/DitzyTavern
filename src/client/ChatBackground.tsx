import { ImagePlus, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ConversationSummary } from "./conversation";
import { conversationKey } from "./conversation-query";
import { runConversationCommand } from "./conversation-command-runner";
import { imageAccept, imageSrc, uploadImage } from "./lib/image";
import { useReducedMotion } from "./lib/use-media";

// @approved
// A canvas draws an image's first frame, so reduced motion holds a GIF still.
// Without a label the image is decorative.
export function BackgroundImage({ hash, className, label }: { hash: string; className: string; label?: string }) {
	const still = useReducedMotion();
	const drawFirstFrame = useCallback((canvas: HTMLCanvasElement | null) => {
		if (canvas === null) return;
		const image = new Image();
		image.onload = () => {
			// @approved
			// Drawn at the size it covers, so a large photo does not hold a full-resolution bitmap.
			const scale = Math.min(1, devicePixelRatio * Math.max(canvas.clientWidth / image.naturalWidth, canvas.clientHeight / image.naturalHeight));
			canvas.width = Math.round(image.naturalWidth * scale);
			canvas.height = Math.round(image.naturalHeight * scale);
			canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
		};
		image.src = imageSrc(hash);
	}, [hash]);
	return still
		? <canvas ref={drawFirstFrame} className={className} role={label === undefined ? undefined : "img"} aria-label={label} aria-hidden={label === undefined} />
		: <img src={imageSrc(hash)} alt={label ?? ""} className={className} />;
}

export function ChatBackgroundSetting({ conversation, onConversationChange }: {
	conversation: ConversationSummary;
	onConversationChange: (conversation: ConversationSummary) => void;
}) {
	const client = useQueryClient();
	const picker = useRef<HTMLInputElement>(null);
	const [pending, setPending] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	// @approved
	// Read at send time: the Chat can advance while an upload is in flight.
	const revision = () => client.getQueryData<ConversationSummary | null>(conversationKey(conversation.id))?.revision ?? null;
	const apply = async (hash: () => Promise<string | null>) => {
		setPending(true);
		setNotice(null);
		try {
			await runConversationCommand({ conversationId: conversation.id, revision, onConversationChange, setNotice }, { type: "set-background", hash: await hash() });
		} catch (cause) {
			setNotice(cause instanceof Error ? cause.message : "That file could not be read as an image.");
		} finally {
			setPending(false);
		}
	};
	const { background } = conversation;
	return (
		<section className="chat-background-section" aria-label="Background">
			<h3>Background</h3>
			{background !== null && <BackgroundImage key={background} hash={background} className="chat-background-preview" label="Current background" />}
			<p className="panel-note">Shown faded behind the story. PNG, JPEG, WebP, or GIF up to 20 MB.</p>
			<div className="chat-background-actions">
				<Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => picker.current?.click()}>
					<ImagePlus aria-hidden="true" /> {background === null ? "Choose image" : "Replace"}
				</Button>
				{background !== null && <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => void apply(async () => null)}>
					<Trash2 aria-hidden="true" /> Remove
				</Button>}
			</div>
			{notice !== null && <p className="import-problem" role="alert">{notice}</p>}
			<input ref={picker} type="file" accept={imageAccept} className="sr-only" aria-label="Background file" onChange={(event) => {
				const file = event.target.files?.[0];
				event.target.value = "";
				if (file !== undefined) void apply(async () => (await uploadImage(file)).hash);
			}} />
		</section>
	);
}
