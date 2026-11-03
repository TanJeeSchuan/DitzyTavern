export default { read: ({ setup }, { snapshot }) => ({ view: { setup, images: snapshot({ scope: "library", prefix: "image:" }) } }) };
