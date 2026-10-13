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
// working. `header` stands in for a header the surface drew itself, such as
// an inspector's with its close button. React catches render errors only in
// a class component.
export class BoxBoundary extends Component<{ box: BoxId; header?: ReactNode; children: ReactNode }, BoxBoundaryState> {
	override state: BoxBoundaryState = { message: null };
	static getDerivedStateFromError(cause: unknown): BoxBoundaryState {
		return { message: errorMessage(cause) };
	}
	override render() {
		const { box, header, children } = this.props;
		return this.state.message === null ? children : <>{header}<BoxFailure box={box} message={this.state.message} /></>;
	}
}
