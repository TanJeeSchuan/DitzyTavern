import { hasMoves, type BoxMoves } from "../../shared/contract/box-generation";
import type { Portrait as PortraitImage } from "../../shared/contract/image";
import { GenerationSphere } from "./GenerationSphere";
import { LensedProse, type StoryLens } from "./LensedProse";
import { MoveChips } from "./MoveChips";
import { Portrait } from "./Portrait";

type Author = { name: string; portrait?: PortraitImage | undefined };

// A Requested Send (or Continue) before the server accepts it: the writer's Message, when it adds one, and the
// reply in progress. The accepted Messages replace it in the same render that places them. The writer's Message
// shows its Moves and goes through the story's lenses as the accepted one will.
export function RequestedSendView({ human, sent, model, lens }: {
	human: Author;
	sent: { content: string; moves?: BoxMoves | undefined } | null;
	model: Author;
	lens: StoryLens | undefined;
}) {
	return (
		<>
			{sent !== null && (
				<article className="story-message" data-requested="true">
					<header className="message-header">
						<Portrait name={human.name} portrait={human.portrait} size="medium" />
						<div className="message-author"><strong>{human.name}</strong></div>
					</header>
					<MoveChips moves={sent.moves ?? {}} disabled />
					{!(sent.content.trim() === "" && hasMoves(sent.moves)) && (
						<div className="variant-content"><div className="prose"><LensedProse text={sent.content} streaming={false} lens={lens} /></div></div>
					)}
				</article>
			)}
			<article className="story-message" data-requested="true">
				<header className="message-header">
					<Portrait name={model.name} portrait={model.portrait} size="medium" />
					<div className="message-author">
						<strong>{model.name}</strong>
						<GenerationSphere authorName={model.name} />
					</div>
				</header>
				<div className="variant-content"><div className="prose" data-generation-active="true" /></div>
			</article>
		</>
	);
}
