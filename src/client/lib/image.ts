import { api } from "./eden";
export const imageAccept = "image/png,image/jpeg,image/webp,image/gif";
export const imageSrc = (hash: string) => `/api/images/${hash}`;
/** @approved A file's bytes as base64, the form the upload routes take. */
export const encodeImage = (file: Blob) => new Promise<string>((resolve, reject) => {
	const reader = new FileReader();
	reader.onload = () => resolve(String(reader.result).split(",")[1]!); // @approved A data URL always has a comma.
	reader.onerror = () => reject(reader.error);
	reader.readAsDataURL(file);
});
export const uploadImage = async (file: File) => {
	const { data, error } = await api.api.images.post({ data: await encodeImage(file) });
	if (error) throw new Error(error.value.reason);
	return data;
};
