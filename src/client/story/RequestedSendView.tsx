import type { Portrait as PortraitImage } from "../../shared/contract/image";
import { GenerationSphere } from "./GenerationSphere";
import { Portrait } from "./Portrait";
import { Prose } from "./prose";

type Author = { name: string; portrait?: PortraitImage | undefined };

// A Requested Send (or Continue) before the server accepts it: the writer's Message, when it adds one, and the
// reply in progress. The accepted Messages replace it in the same render that places them.
export function RequestedSendView({ human, content, model }: { human: Author; content: string | null; model: Author }) {
	return (
		<>
			{content !== null && (
				<article className="story-message" data-requested="true">
					<header className="message-header">
						<Portrait name={human.name} portrait={human.portrait} size="medium" />
						<div className="message-author"><strong>{human.name}</strong></div>
					</header>
					<div className="variant-content"><div className="prose"><Prose text={content} streaming={false} /></div></div>
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
