export const downloadFileInBrowser = (
	filename: string,
	mediaType: string,
	bytes: Uint8Array,
	click: (href: string, download: string) => void = (href, download) => {
		const anchor = document.createElement("a");
		anchor.href = href;
		anchor.download = download;
		document.body.appendChild(anchor);
		anchor.click();
		anchor.remove();
	},
): void => {
	const objectUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mediaType }));
	try {
		click(objectUrl, filename);
	} finally {
		window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
	}
};
