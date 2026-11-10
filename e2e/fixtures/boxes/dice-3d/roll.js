export const rolled = (seed, sides) => parseInt(seed.slice(0, 8), 16) % sides + 1;
