/** Interface palette: 黑底红字 ("dark", default) or the original red poster ("poster"). */
export type Palette = "dark" | "poster";
const storageKey = "tma.palette";

export function storedPalette(): Palette {
  try { return window.localStorage.getItem(storageKey) === "poster" ? "poster" : "dark"; } catch { return "dark"; }
}

export function applyPalette(palette: Palette) {
  document.documentElement.dataset.palette = palette;
  try { window.localStorage.setItem(storageKey, palette); } catch { /* storage can be unavailable */ }
  window.dispatchEvent(new CustomEvent("tma-palette-change", { detail: palette }));
}

let cachedFor: string | undefined;
let cachedInk = "22, 0, 0";
let cachedPaper = "255, 20, 70";

function refresh() {
  const current = document.documentElement.dataset.palette ?? "";
  if (current === cachedFor) return;
  const style = getComputedStyle(document.documentElement);
  cachedInk = style.getPropertyValue("--ink-rgb").trim() || cachedInk;
  cachedPaper = style.getPropertyValue("--red-rgb").trim() || cachedPaper;
  cachedFor = current;
}

/** "r, g, b" of the current ink (lines and type) for canvas drawing. */
export function inkRgb() { refresh(); return cachedInk; }
/** "r, g, b" of the current paper (ground) for canvas drawing. */
export function paperRgb() { refresh(); return cachedPaper; }
export function isDarkPalette() { return (document.documentElement.dataset.palette ?? "dark") === "dark"; }
