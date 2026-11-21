export const MAX_CUSTOM_PANEL_RESULTS = 30;
export const DEFAULT_CATEGORY_RESULTS = 12;
export const DEFAULT_MONTHLY_RESULTS = 24;

export type RequestedResultCount = {
  count: number;
  mode: "top" | "bottom" | "recent" | "first";
};

const quantities: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  "twenty one": 21, "twenty two": 22, "twenty three": 23,
  "twenty four": 24, "twenty five": 25, "twenty six": 26,
  "twenty seven": 27, "twenty eight": 28, "twenty nine": 29,
  thirty: 30
};
const words = Object.keys(quantities).sort((a,b) => b.length - a.length)
  .map(word => word.replace(/ /g, "[ -]")).join("|");

export function parseRequestedResultCount(prompt: string): RequestedResultCount | null {
  const pattern = new RegExp("\\b(top|bottom|latest|recent|last|first)\\s*(?:[-:]\\s*|the\\s+)?(\\d{1,3}|" + words + ")\\b", "i");
  const found = pattern.exec(prompt);
  if (!found) return null;
  const raw = found[2].toLowerCase().replace(/-/g, " ");
  const count = /^\d+$/.test(raw) ? Number(raw) : quantities[raw];
  if (!Number.isInteger(count) || count < 1 || count > MAX_CUSTOM_PANEL_RESULTS) {
    throw new Error("Custom panels support between 1 and " + MAX_CUSTOM_PANEL_RESULTS + " ranked items or months. Adjust the requested count.");
  }
  const keyword = found[1].toLowerCase();
  return {
    count,
    mode: keyword === "bottom" ? "bottom" : ["last","latest","recent"].includes(keyword) ? "recent" : keyword === "first" ? "first" : "top"
  };
}

export function verifiedResultCount(value: unknown, fallback: number): number {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_CUSTOM_PANEL_RESULTS) {
    throw new Error("The saved panel has an invalid result limit.");
  }
  return value;
}

export function verifiedSortDirection(value: unknown): "asc" | "desc" {
  if (value === null || value === undefined) return "desc";
  if (value === "asc" || value === "desc") return value;
  throw new Error("The saved panel has an invalid sorting rule.");
}
