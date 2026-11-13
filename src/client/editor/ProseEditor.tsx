import { defaultKeymap, history, historyKeymap, isolateHistory } from "@codemirror/commands";
import { Compartment, EditorSelection, EditorState, type Range, type SelectionRange, type TransactionSpec } from "@codemirror/state";
import { Decoration, type DecorationSet, drawSelection, EditorView, keymap, ViewPlugin, WidgetType } from "@codemirror/view";
import { ImagePlus } from "lucide-react";
import { type Ref, type ReactNode, useEffect, useImperativeHandle, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { formatImageReference, parseImageReferences } from "../../shared/image-reference";
import { ImageDialogProvider, useOpenImageAt, type OpenedImage } from "../ImageDialog";
import { imageAccept, imageSrc, uploadImage } from "../lib/image";

export interface ProseEditorHandle {
	focus: () => void;
	insertReference: (name: string, hash: string) => void;
	appendText: (text: string) => void;
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
		chip.dataset.imageHash = this.hash;
		chip.dataset.imageName = this.name;
		const thumbnail = document.createElement("img");
		thumbnail.src = imageSrc(this.hash);
		thumbnail.alt = "";
		thumbnail.draggable = false;
		thumbnail.addEventListener("error", () => chip.setAttribute("data-missing", "true"));
		const label = document.createElement("span");
		label.textContent = this.name;
		chip.append(thumbnail, label);
		const anchor = document.createElement("span");
		anchor.append(chip);
		return anchor;
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
	".cm-content": { padding: "0" },
	".cm-cursor": { borderLeftColor: "currentColor" },
	"&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": { background: "color-mix(in oklch, var(--accent) 28%, transparent)" },
	".cm-line": { padding: "0" },
});

const baseName = (fileName: string) => fileName.replace(/\.[^.]+$/, "");

const editability = (disabled: boolean) => [EditorView.editable.of(!disabled), EditorView.contentAttributes.of({ "aria-disabled": String(disabled) })];

const contentAttributes = (ariaLabel: string, placeholder: string) =>
	EditorView.contentAttributes.of({ "aria-label": ariaLabel, "aria-placeholder": placeholder, "aria-multiline": "true", spellcheck: "true" });

type ProseEditorProps = {
	ref?: Ref<ProseEditorHandle>;
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	disabled?: boolean;
	ariaLabel: string;
	className?: string;
	autoFocus?: boolean;
	imageActions?: (image: OpenedImage) => ReactNode;
};

export function ProseEditor(props: ProseEditorProps) {
	return props.imageActions === undefined ? <Editor {...props} /> : <ImageDialogProvider actions={props.imageActions}><Editor {...props} /></ImageDialogProvider>;
}

function Editor({
	ref,
	value,
	onChange,
	placeholder = "",
	disabled = false,
	ariaLabel,
	className,
	autoFocus = false,
}: ProseEditorProps) {
	const host = useRef<HTMLDivElement>(null);
	const picker = useRef<HTMLInputElement>(null);
	const view = useRef<EditorView | null>(null);
	const pendingInsertions = useRef(new Set<{ range: SelectionRange }>());
	const openedReferences = useRef(new Set<{ range: SelectionRange; text: string }>());
	const onChangeRef = useRef(onChange);
	const openImageAt = useOpenImageAt();
	const [error, setError] = useState<string | null>(null);
	const [settings] = useState(() => ({ editable: new Compartment(), label: new Compartment() }));
	onChangeRef.current = onChange;

	const insert = async (files: readonly File[], at?: number) => {
		const editor = view.current;
		if (editor === null || !editor.state.facet(EditorView.editable) || files.length === 0) return;
		const selection = editor.state.selection.main;
		const pending = { range: at === undefined ? selection : EditorSelection.cursor(at) };

		pendingInsertions.current.add(pending);
		try {
			const prepared: string[] = [];
			for (const file of files) {
				prepared.push(formatImageReference(baseName(file.name), (await uploadImage(file)).hash));
				if (view.current !== editor) return;
			}
			if (view.current !== editor || !editor.state.facet(EditorView.editable)) return;
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
		}
	};
	const insertRef = useRef(insert);
	insertRef.current = insert;

	useImperativeHandle(ref, () => ({
		focus: () => view.current?.focus(),
		appendText: (text) => {
			const editor = view.current;
			if (editor === null || !editor.state.facet(EditorView.editable)) return;
			editor.dispatch({ changes: { from: editor.state.doc.length, insert: `${editor.state.doc.length === 0 ? "" : "\n\n"}${text}` }, annotations: isolateHistory.of("full"), userEvent: "input" });
		},
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

		const imageFiles = (files: FileList | null | undefined) => [...(files ?? [])].filter((file) => file.type.startsWith("image/"));
		const editor = new EditorView({
			parent: host.current,
			state: EditorState.create({
				doc: value,
				extensions: [
					EditorState.lineSeparator.of("\n"),
					history(),
					drawSelection(),
					keymap.of([...defaultKeymap, ...historyKeymap]),
					EditorView.lineWrapping,
					chipPlugin,
					theme,
					settings.editable.of(editability(disabled)),
					settings.label.of(contentAttributes(ariaLabel, placeholder)),
					EditorView.updateListener.of((update) => {
						if (update.docChanged) {
							for (const reference of openedReferences.current) {
								const from = update.changes.mapPos(reference.range.from, 1);
								const to = update.changes.mapPos(reference.range.to, -1);
								if (from < to && update.state.doc.sliceString(from, to) === reference.text) reference.range = EditorSelection.range(from, to);
								else openedReferences.current.delete(reference);
							}
							for (const pending of pendingInsertions.current) {
								pending.range = !pending.range.empty && update.changes.touchesRange(pending.range.from, pending.range.to)
									? EditorSelection.cursor(update.changes.mapPos(pending.range.to, 1))
									: pending.range.map(update.changes, 1);
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
		const selectImageChips = () => {
			const selection = document.getSelection();
			if (!editor.hasFocus || selection === null || selection.isCollapsed || selection.rangeCount === 0) return;
			const range = selection.getRangeAt(0).cloneRange();
			const chipAt = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest(".image-chip") ?? null;
			const start = chipAt(range.startContainer);
			const end = chipAt(range.endContainer);
			if (start === null && end === null || !editor.contentDOM.contains(range.commonAncestorContainer)) return;
			const backwards = selection.anchorNode === range.endContainer && selection.anchorOffset === range.endOffset;
			if (start !== null) range.setStartBefore(start.parentNode!);
			if (end !== null) range.setEndAfter(end.parentNode!);
			selection.setBaseAndExtent(
				backwards ? range.endContainer : range.startContainer, backwards ? range.endOffset : range.startOffset,
				backwards ? range.startContainer : range.endContainer, backwards ? range.startOffset : range.endOffset,
			);
		};
		document.addEventListener("selectionchange", selectImageChips, true);
		if (autoFocus) {
			editor.dispatch({ selection: EditorSelection.cursor(editor.state.doc.length) });
			editor.focus();
		}
		return () => {
			document.removeEventListener("selectionchange", selectImageChips, true);
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
				settings.editable.reconfigure(editability(disabled)),
				settings.label.reconfigure(contentAttributes(ariaLabel, placeholder)),
			],
		});
	}, [placeholder, disabled, ariaLabel]);

	const openImage = (target: EventTarget) => {
		const chip = target instanceof Element ? target.closest(".image-chip") : null;
		const editor = view.current;
		if (chip === null || editor === null) return openImageAt(target);
		const position = editor.posAtDOM(chip);
		const reference = parseImageReferences(editor.state.doc.toString()).find(({ start }) => start === position);
		if (reference === undefined) return openImageAt(target);
		const tracked = [...openedReferences.current].find(({ range }) => range.from === reference.start && range.to === reference.end)
			?? { range: EditorSelection.range(reference.start, reference.end), text: editor.state.doc.sliceString(reference.start, reference.end) };
		openedReferences.current.add(tracked);
		openImageAt(target, {
			insertAfter: (text) => {
				if (view.current !== editor || !editor.state.facet(EditorView.editable) || !openedReferences.current.has(tracked)) return false;
				const after = editor.state.doc.sliceString(tracked.range.to);
				const separators = after.length === 0 ? "" : after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
				editor.dispatch({ changes: { from: tracked.range.to, insert: `\n\n${text}${separators}` }, annotations: isolateHistory.of("full"), userEvent: "input" });
				return true;
			},
		});
	};
	return (
		<div className={cn("prose-editor", className)} data-disabled={disabled} onClick={(event) => openImage(event.target)}>
			<div ref={host} className="prose-editor-host" data-placeholder={value === "" ? placeholder : undefined} />
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
