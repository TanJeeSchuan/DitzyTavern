import type { Portrait as PortraitImage } from "../../shared/contract/image";
import { imageSrc } from "../lib/image";

export const focalPosition = (portrait: PortraitImage) => `${portrait.focalX * 100}% ${portrait.focalY * 100}%`;

export function Portrait({ name, size, portrait }: { name?: string; size: "small" | "medium" | "large"; portrait?: PortraitImage | null | undefined }) {
	const initial = name?.trim().charAt(0).toLocaleUpperCase() ?? "?";
	return (
		<span className="portrait" data-size={size} aria-hidden="true">
			{portrait ? <img src={imageSrc(portrait.hash)} alt="" style={{ objectPosition: focalPosition(portrait) }} /> : <span>{initial}</span>}
		</span>
	);
}
