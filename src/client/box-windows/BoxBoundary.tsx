import { TriangleAlert, type LucideIcon } from "lucide-react";
import { Component, type ReactNode } from "react";
import type { BoxId } from "../../shared/contract/box";
import { boxTitle, errorMessage } from "./registry";

/** @approved A failed Box surface's message, naming the Box. */
export const BoxFailure = ({ box, message }: { box: BoxId; message: string }) =>
	<span className="box-failure" role="alert">{boxTitle(box)} failed: {message}</span>;

type BoxBoundaryState = { readonly message: string | null };

// @approved
//  Every Box surface renders inside one, within its host frame: a surface
// that throws is replaced by its failure, and the rest of the Chat keeps
// working. `fallback` places the failure in the frame, such as under a
// header standing in for the one an inspector drew itself. React catches
// render errors only in a class component.
export class BoxBoundary extends Component<{ box: BoxId; fallback?: (failure: ReactNode) => ReactNode; children: ReactNode }, BoxBoundaryState> {
	override state: BoxBoundaryState = { message: null };
	static getDerivedStateFromError(cause: unknown): BoxBoundaryState {
		return { message: errorMessage(cause) };
	}
	override render() {
		const { box, fallback = (failure) => failure, children } = this.props;
		return this.state.message === null ? children : fallback(<BoxFailure box={box} message={this.state.message} />);
	}
}

/** @approved A Box's icon in a host control, which names the Box; an icon that throws leaves an alert icon in its place. */
export const BoxIcon = ({ box, icon: Icon }: { box: BoxId; icon: LucideIcon }) =>
	<BoxBoundary box={box} fallback={() => <TriangleAlert aria-hidden="true" />}><Icon aria-hidden="true" /></BoxBoundary>;
