import type { ReactNode } from "react";

export function NumberGroup({ title, description, children }: { title: ReactNode; description: string; children: ReactNode }) {
	return (
		<div className="mt-6 grid gap-2">
			<h4 className="m-0 flex items-center gap-1 text-[0.8rem] font-semibold">{title}</h4>
			<p className="-mt-1 mb-1 text-xs leading-normal text-muted-foreground">{description}</p>
			{children}
		</div>
	);
}

export function NumberRow({ id, label, value, onChange, ...limits }: { id: string; label: string; value: number; min: number; max?: number; step: number; onChange: (value: number) => void }) {
	return (
		<div className="flex items-center justify-between gap-3">
			<label htmlFor={id} className="whitespace-nowrap text-[13px] font-medium text-muted-foreground">{label}</label>
			<span className="w-20"><input id={id} className="field-input text-right tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" type="number" {...limits} value={value} onChange={(event) => onChange(Number(event.target.value))} /></span>
		</div>
	);
}
