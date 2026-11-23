export const PI_WORKING_LINE_DEFAULT_PHRASES = [
  "Sautéing",
  "Cooking",
  "Ionizing",
  "Zigzagging",
  "Razzle-dazzling",
  "Photosynthesizing",
  "Nucleating",
  "Brewing",
  "Combobulating",
  "Boogieing",
  "Befuddling",
  "Alchemizing",
  "Conjuring",
  "Baking",
  "Simmering",
  "Blanching",
] as const;

export const PI_WORKING_LINE_MESSAGES = PI_WORKING_LINE_DEFAULT_PHRASES.map(
  (phrase) => `${phrase}…`,
);
