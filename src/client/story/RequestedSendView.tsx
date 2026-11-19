import { hasMoves } from "../../shared/contract/box-generation";
import type { Portrait as PortraitImage } from "../../shared/contract/image";
import { isStoryReady, reusesTrailingHumanMessage, type StoryState } from "../story";
import { GenerationSphere } from "./GenerationSphere";
import { LensedProse, type StoryLens } from "./LensedProse";
import { MoveChips } from "./MoveChips";
import { Portrait } from "./Portrait";

type Author = { name: string; portrait?: PortraitImage | undefined };

// @approved
//  A Requested Send (or Continue) before the server accepts it: the writer's Message, when it adds one, and the
// reply in progress. The accepted Messages replace it in the same render that places them. The writer's Message
// shows its Moves and goes through the story's lenses as the accepted one will.
export function RequestedSendView({ story, human, model, lens }: {
	story: StoryState;
	human: (Author & { id: number }) | null;
	model: Author | null;
	lens: StoryLens | undefined;
}) {
	const request = story.requestedGeneration?.request;
	if (human === null || model === null || request === undefined || request.kind === "sibling" || (isStoryReady(story) && story.page.hasNewer)) return null;
	const sent = request.kind === "send" && !reusesTrailingHumanMessage(story, human.id, request.content, request.moves) ? request : null;
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
