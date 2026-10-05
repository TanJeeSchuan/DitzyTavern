import { defaultKeymap, history, historyField, historyKeymap } from "@codemirror/commands";
import { Compartment, EditorSelection, EditorState, type Range, type SelectionRange, type TransactionSpec } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, placeholder as placeholderExtension, ViewPlugin, WidgetType } from "@codemirror/view";
import { ImagePlus } from "lucide-react";
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { formatImageReference, jsonImageHashes, parseImageReferences } from "../../shared/image-reference";
import { ImageDraft, imageAccept, imageSrc, prepareImage } from "../lib/image";

export interface ProseEditorHandle {
	focus: () => void;
	insertReference: (name: string, hash: string) => void;
}

class ImageChip extends WidgetType {
	constructor(readonly name: string, readonly hash: string) {
		super();
	}

	eq(other: ImageChip) {
		return other.name === this.name && other.hash === this.hash;
	}

	toDOM() {
		const chip = document.createElement("span");
		chip.className = "image-chip";
		chip.title = this.name;
		const thumbnail = document.createElement("img");
		thumbnail.src = imageSrc(this.hash);
		thumbnail.alt = "";
		thumbnail.draggable = false;
		thumbnail.addEventListener("error", () => chip.setAttribute("data-missing", "true"));
		const label = document.createElement("span");
		label.textContent = this.name;
		chip.append(thumbnail, label);
		return chip;
	}
}

const chips = (view: EditorView): DecorationSet => {
	const ranges: Range<Decoration>[] = parseImageReferences(view.state.doc.toString()).map((reference) =>
		Decoration.replace({ widget: new ImageChip(reference.name, reference.hash) }).range(reference.start, reference.end),
	);
	return Decoration.set(ranges);
};

const chipPlugin = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;
		constructor(view: EditorView) {
			this.decorations = chips(view);
		}
		update(update: { docChanged: boolean; view: EditorView }) {
			if (update.docChanged) this.decorations = chips(update.view);
		}
	},
	{
		decorations: (plugin) => plugin.decorations,
		provide: (plugin) => EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none),
	},
);

const theme = EditorView.theme({
	"&": { backgroundColor: "transparent", color: "inherit" },
	"&.cm-focused": { outline: "none" },
	".cm-scroller": { fontFamily: "inherit", lineHeight: "inherit", overflow: "visible" },
	".cm-content": { padding: "0", caretColor: "currentColor" },
	".cm-line": { padding: "0" },
	".cm-placeholder": { color: "var(--text-muted)" },
});

const baseName = (fileName: string) => fileName.replace(/\.[^.]+$/, "");

export function ProseEditor({
	ref,
	value,
	onChange,
	placeholder = "",
	disabled = false,
	ariaLabel,
	className,
	autoFocus = false,
}: {
	ref?: Ref<ProseEditorHandle>;
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	disabled?: boolean;
	ariaLabel: string;
	className?: string;
	autoFocus?: boolean;
}) {
	const host = useRef<HTMLDivElement>(null);
	const picker = useRef<HTMLInputElement>(null);
	const view = useRef<EditorView | null>(null);
	const imageDraft = useRef<ImageDraft | null>(null);
	const pendingInsertions = useRef(new Set<{ range: SelectionRange }>());
	const onChangeRef = useRef(onChange);
	const [error, setError] = useState<string | null>(null);
	const [settings] = useState(() => ({ placeholder: new Compartment(), editable: new Compartment(), label: new Compartment() }));
	onChangeRef.current = onChange;

	const insert = async (files: readonly File[], at?: number) => {
		const editor = view.current;
		const draft = imageDraft.current;
		if (editor === null || draft === null || !editor.state.facet(EditorView.editable) || files.length === 0) return;
		const selection = editor.state.selection.main;
		const pending = { range: at === undefined ? selection : EditorSelection.cursor(at) };
		const insertionDraft = new ImageDraft();
		pendingInsertions.current.add(pending);
		try {
			const prepared: string[] = [];
			for (const file of files) {
				prepared.push(formatImageReference(baseName(file.name), (await prepareImage(file, insertionDraft)).hash));
				if (view.current !== editor) return;
			}
			if (view.current !== editor || !editor.state.facet(EditorView.editable)) return;
			if (!pendingInsertions.current.has(pending)) {
				setError("The selected text changed while the image was being prepared. Paste the image again.");
				return;
			}
			const { from, to } = pending.range;
			const selectionUnchanged = editor.state.selection.main.eq(pending.range);
			const text = prepared.join(" ");
			const transaction: TransactionSpec = {
				changes: { from, to, insert: text },
				userEvent: "input.paste",
			};
			if (selectionUnchanged) transaction.selection = EditorSelection.cursor(from + text.length);
			editor.dispatch(transaction);
			if (selectionUnchanged) editor.focus();
			setError(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "That file could not be read as an image.");
		} finally {
			pendingInsertions.current.delete(pending);
			if (view.current === editor) draft.setHashes(jsonImageHashes(editor.state.toJSON({ history: historyField })));
			insertionDraft.dispose();
		}
	};
	const insertRef = useRef(insert);
	insertRef.current = insert;

	useImperativeHandle(ref, () => ({
		focus: () => view.current?.focus(),
		insertReference: (name, hash) => {
			const editor = view.current;
			if (editor === null || !editor.state.facet(EditorView.editable)) return;
			const { from, to } = editor.state.selection.main;
			const text = formatImageReference(name, hash);
			editor.dispatch({ changes: { from, to, insert: text }, selection: EditorSelection.cursor(from + text.length) });
			editor.focus();
		},
	}), []);

	useEffect(() => {
		if (host.current === null) return;
		const draft = new ImageDraft();
		imageDraft.current = draft;
		draft.setHashes(jsonImageHashes(value));
		const imageFiles = (files: FileList | null | undefined) => [...(files ?? [])].filter((file) => file.type.startsWith("image/"));
		const editor = new EditorView({
			parent: host.current,
			state: EditorState.create({
				doc: value,
				extensions: [
					EditorState.lineSeparator.of("\n"),
					history(),
					keymap.of([...defaultKeymap, ...historyKeymap]),
					EditorView.lineWrapping,
					chipPlugin,
					theme,
					settings.placeholder.of(placeholderExtension(placeholder)),
					settings.editable.of(EditorView.editable.of(!disabled)),
					settings.label.of(EditorView.contentAttributes.of({ "aria-label": ariaLabel, "aria-multiline": "true", spellcheck: "true" })),
					EditorView.updateListener.of((update) => {
						if (update.docChanged) {
							draft.setHashes(jsonImageHashes(update.state.toJSON({ history: historyField })));
							for (const pending of pendingInsertions.current) {
								update.changes.iterChangedRanges((from, to) => {
									if (!pending.range.empty && from <= pending.range.to && to >= pending.range.from) pendingInsertions.current.delete(pending);
								});
								pending.range = pending.range.map(update.changes, 1);
							}
							onChangeRef.current(update.state.doc.toString());
						}
					}),
					EditorView.domEventHandlers({
						paste: (event, target) => {
							const files = imageFiles(event.clipboardData?.files);
							if (files.length === 0 || !target.state.facet(EditorView.editable)) return false;
							event.preventDefault();
							void insertRef.current(files);
							return true;
						},
						drop: (event, target) => {
							const files = imageFiles(event.dataTransfer?.files);
							if (files.length === 0 || !target.state.facet(EditorView.editable)) return false;
							event.preventDefault();
							void insertRef.current(files, target.posAtCoords({ x: event.clientX, y: event.clientY }) ?? undefined);
							return true;
						},
					}),
				],
			}),
		});
		view.current = editor;
		if (autoFocus) {
			editor.dispatch({ selection: EditorSelection.cursor(editor.state.doc.length) });
			editor.focus();
		}
		return () => {
			draft.dispose();
			imageDraft.current = null;
			editor.destroy();
			view.current = null;
		};
	}, []);

	useEffect(() => {
		const editor = view.current;
		if (editor !== null && editor.state.doc.toString() !== value) {
			editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
		}
	}, [value]);

	useEffect(() => {
		view.current?.dispatch({
			effects: [
				settings.placeholder.reconfigure(placeholderExtension(placeholder)),
				settings.editable.reconfigure(EditorView.editable.of(!disabled)),
				settings.label.reconfigure(EditorView.contentAttributes.of({ "aria-label": ariaLabel, "aria-multiline": "true", spellcheck: "true" })),
			],
		});
	}, [placeholder, disabled, ariaLabel]);

	return (
		<div className={cn("prose-editor", className)} data-disabled={disabled}>
			<div ref={host} className="prose-editor-host" />
			<button type="button" className="prose-editor-add" aria-label="Add an image" title="Add an image" disabled={disabled} onClick={() => picker.current?.click()}>
				<ImagePlus aria-hidden="true" />
			</button>
			<input
				ref={picker}
				type="file"
				accept={imageAccept}
				multiple
				className="sr-only"
				aria-hidden="true"
				tabIndex={-1}
				onChange={(event) => {
					void insert([...(event.target.files ?? [])]);
					event.target.value = "";
				}}
			/>
			{error !== null && <p className="prose-editor-error" role="alert">{error}</p>}
		</div>
	);
}
