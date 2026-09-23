import type { ReactNode } from "react";

export function Field({ label, htmlFor, helper, className, children }: {
	label: ReactNode;
	htmlFor?: string;
	helper?: ReactNode;
	className?: string;
	children: ReactNode;
}) {
	return <div className={className ? `field ${className}` : "field"}>
		{htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span className="field-label">{label}</span>}
		{children}
		{helper && <small>{helper}</small>}
	</div>;
}
