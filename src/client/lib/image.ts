import { api } from "./eden";
export const imageAccept = "image/png,image/jpeg,image/webp,image/gif";
export const imageSrc = (hash: string) => `/api/images/${hash}`;
export const uploadImage = async (file: File) => {
	const encoded = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result).split(",")[1]!);
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
	const { data, error } = await api.api.images.post({ data: encoded });
	if (error) throw new Error(error.value.reason);
	return data;
};
