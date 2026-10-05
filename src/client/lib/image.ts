import { transformExif } from "@uwx/exif-be-gone-web";
import { MAX_IMAGE_BYTES } from "../../shared/contract/image";

export interface PreparedImage {
	hash: string;
	data: string;
}

export const imageAccept = "image/png,image/jpeg,image/webp,image/gif";

export const missingImages = new Set<string>();
const drafts = new Set<ImageDraft>();
const localImages = new Map<string, { data: string; url: string }>();
const loads = new Map<string, Promise<void>>();
const loadErrors = new Map<string, unknown>();

export const hasLocalImage = (hash: string) => localImages.has(hash);

export const imageSrc = (hash: string) => localImages.get(hash)?.url ?? `/api/images/${hash}`;

const releaseUnused = () => {
	for (const hash of loadErrors.keys()) if (![...drafts].some((draft) => draft.hashes.has(hash))) loadErrors.delete(hash);
	for (const [hash, image] of localImages) if (![...drafts].some((draft) => draft.hashes.has(hash))) {
		URL.revokeObjectURL(image.url);
		localImages.delete(hash);
	}
};

export class ImageDraft {
	readonly hashes = new Set<string>();
	private disposed = false;
	activate() { this.disposed = false; drafts.add(this); }
	setHashes(hashes: Iterable<string>) {
		if (this.disposed) return;
		drafts.add(this);
		this.hashes.clear();
		for (const hash of hashes) this.hashes.add(hash);
		for (const hash of this.hashes) if (!localImages.has(hash) && !loads.has(hash)) {
			loadErrors.delete(hash);
			const load = fetch(`/api/images/${hash}`).then(async (response) => {
				if (response.status === 404) return;
				if (!response.ok) throw new Error("The draft's image bytes could not be retained. Reopen the editor before saving.");
				const blob = await response.blob();
				if (!localImages.has(hash)) localImages.set(hash, { data: toBase64(new Uint8Array(await blob.arrayBuffer())), url: URL.createObjectURL(blob) });
			}).catch((cause: unknown) => { loadErrors.set(hash, cause); }).finally(() => { loads.delete(hash); releaseUnused(); });
			loads.set(hash, load);
		}
		releaseUnused();
	}
	retain(hash: string) { if (!this.disposed) { drafts.add(this); this.hashes.add(hash); } }
	get active() { return !this.disposed; }
	dispose() { this.disposed = true; drafts.delete(this); this.hashes.clear(); releaseUnused(); }
}

const toHex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const toBase64 = (bytes: Uint8Array) => {
	let binary = "";
	for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
	return btoa(binary);
};

export const prepareImage = async (file: File, draft: ImageDraft): Promise<PreparedImage> => {
	if (file.size > MAX_IMAGE_BYTES) throw new Error("Images may be at most 20 MB.");
	const original = new Uint8Array(await file.arrayBuffer());
	const hash = toHex(await crypto.subtle.digest("SHA-256", new Uint8Array(await transformExif(original))));
	const data = toBase64(original);
	if (!draft.active) throw new Error("The image draft was closed.");
	draft.retain(hash);
	if (!localImages.has(hash)) localImages.set(hash, { data, url: URL.createObjectURL(file) });
	missingImages.delete(hash);
	return { hash, data };
};

const hashesIn = (payloadJson: string) => new Set(payloadJson.match(/[0-9a-f]{64}/g) ?? []);

export const withInlineImages = async <Result extends { error: unknown }>(
	payloadJson: string,
	send: (images: string[] | undefined) => Promise<Result>,
): Promise<Result> => {
	await Promise.all(loads.values());
	if (loadErrors.size > 0) throw loadErrors.values().next().value;
	const images = [...hashesIn(payloadJson)].flatMap((hash) => localImages.has(hash) ? [localImages.get(hash)!.data] : []);
	return send(images.length === 0 ? undefined : images);
};
