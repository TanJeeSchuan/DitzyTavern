export default { read: ({ setup, cast }, { snapshot }) => ({ view: { setup, cast, images: snapshot({ scope: "library", prefix: "image:" }) } }) };
