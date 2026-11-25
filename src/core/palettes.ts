import { validatePalette } from "./doc.ts";

export interface Preset {
  description: string;
  colors: string[];
}

export const PRESETS: Record<string, Preset> = {
  "endesga-32": {
    description: "Endesga 32: long, hue-shifted ramps; strong general-purpose game palette (default).",
    colors: [
      "#be4a2f", "#d77643", "#ead4aa", "#e4a672", "#b86f50", "#733e39", "#3e2731", "#a22633",
      "#e43b44", "#f77622", "#feae34", "#fee761", "#63c74d", "#3e8948", "#265c42", "#193c3e",
      "#124e89", "#0099db", "#2ce8f5", "#ffffff", "#c0cbdc", "#8b9bb4", "#5a6988", "#3a4466",
      "#262b44", "#181425", "#ff0044", "#68386c", "#b55088", "#f6757a", "#e8b796", "#c28569",
    ],
  },
  "sweetie-16": {
    description: "Sweetie 16 by GrafxKid: soft, friendly; great for small sprites and UI.",
    colors: [
      "#1a1c2c", "#5d275d", "#b13e53", "#ef7d57", "#ffcd75", "#a7f070", "#38b764", "#257179",
      "#29366f", "#3b5dc9", "#41a6f6", "#73eff7", "#f4f4f4", "#94b0c2", "#566c86", "#333c57",
    ],
  },
  "pico-8": {
    description: "PICO-8 fantasy console: 16 punchy, saturated colors.",
    colors: [
      "#000000", "#1d2b53", "#7e2553", "#008751", "#ab5236", "#5f574f", "#c2c3c7", "#fff1e8",
      "#ff004d", "#ffa300", "#ffec27", "#00e436", "#29adff", "#83769c", "#ff77a8", "#ffccaa",
    ],
  },
  gameboy: {
    description: "Original Game Boy: 4 greens, dark to light.",
    colors: ["#0f380f", "#306230", "#8bac0f", "#9bbc0f"],
  },
  "1-bit": {
    description: "Black and white.",
    colors: ["#000000", "#ffffff"],
  },
};

export const DEFAULT_PRESET = "endesga-32";

export interface PaletteSpec {
  preset?: string | undefined;
  colors?: string[] | undefined;
  lospec?: string | undefined;
  fromAsset?: string | undefined;
}

export interface ResolvedPalette {
  colors: string[];
  name?: string;
}

export async function fetchLospec(slug: string): Promise<string[]> {
  const s = slug.trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(s)) throw new Error(`Invalid Lospec slug "${slug}" (e.g. "resurrect-64").`);
  let res: Response;
  try {
    res = await fetch(`https://lospec.com/palette-list/${s}.hex`, { signal: AbortSignal.timeout(10000) });
  } catch (e) {
    throw new Error(`Could not reach lospec.com: ${(e as Error).message}`);
  }
  if (!res.ok) {
    throw new Error(`Lospec palette "${s}" not found (HTTP ${res.status}). Browse slugs at https://lospec.com/palette-list`);
  }
  const colors = (await res.text())
    .split(/\s+/)
    .filter((x) => /^[0-9a-f]{6}$/i.test(x))
    .map((x) => `#${x.toLowerCase()}`);
  if (!colors.length) throw new Error(`Lospec palette "${s}" returned no colors.`);
  return colors;
}

export async function resolvePalette(
  spec: PaletteSpec | undefined,
  loadAssetPalette: (name: string) => Promise<{ colors: string[]; name?: string }>,
): Promise<ResolvedPalette> {
  const given = (["preset", "colors", "lospec", "fromAsset"] as const).filter((k) => spec?.[k] !== undefined);
  if (given.length > 1) throw new Error(`Give only one palette source, got: ${given.join(", ")}.`);
  if (!spec || given.length === 0) return { colors: [...PRESETS[DEFAULT_PRESET].colors], name: DEFAULT_PRESET };
  if (spec.preset !== undefined) {
    const key = spec.preset.trim().toLowerCase();
    const p = PRESETS[key];
    if (!p) throw new Error(`Unknown preset "${spec.preset}". Presets: ${Object.keys(PRESETS).join(", ")}; or use lospec.`);
    return { colors: [...p.colors], name: key };
  }
  if (spec.colors !== undefined) return { colors: validatePalette(spec.colors) };
  if (spec.lospec !== undefined) {
    const slug = spec.lospec.trim().toLowerCase();
    return { colors: validatePalette(await fetchLospec(slug)), name: slug };
  }
  const src = await loadAssetPalette(spec.fromAsset!);
  return { colors: [...src.colors], ...(src.name ? { name: src.name } : {}) };
}
