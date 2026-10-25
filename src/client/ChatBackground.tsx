import { ImagePlus, Trash2 } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ConversationSummary } from "./conversation";
import { runConversationCommand } from "./conversation-command-runner";
import { imageAccept, imageSrc, uploadImage } from "./lib/image";
import { useReducedMotion } from "./lib/use-media";

// @approved
// A canvas draws an image's first frame, so reduced motion holds a GIF still.
export function StoryBackground({ hash }: { hash: string }) {
	const still = useReducedMotion();
	const drawFirstFrame = useCallback((canvas: HTMLCanvasElement | null) => {
		if (canvas === null) return;
		const image = new Image();
		image.onload = () => {
			canvas.width = image.naturalWidth;
			canvas.height = image.naturalHeight;
			canvas.getContext("2d")?.drawImage(image, 0, 0);
		};
		image.src = imageSrc(hash);
	}, [hash]);
	return still
		? <canvas ref={drawFirstFrame} className="story-background" aria-hidden="true" />
		: <img src={imageSrc(hash)} alt="" className="story-background" />;
}

export function ChatBackgroundSetting({ conversation, onConversationChange }: {
	conversation: ConversationSummary;
	onConversationChange: (conversation: ConversationSummary) => void;
}) {
	const picker = useRef<HTMLInputElement>(null);
	const [pending, setPending] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const apply = async (hash: () => Promise<string | null>) => {
		setPending(true);
		setNotice(null);
		try {
			await runConversationCommand({ conversationId: conversation.id, revision: () => conversation.revision, onConversationChange, setNotice }, { type: "set-background", hash: await hash() });
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
			{background !== null && <img src={imageSrc(background)} alt="Current background" className="chat-background-preview" />}
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
