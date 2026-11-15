import { Resvg } from "@resvg/resvg-js";
import type { DayStatus } from "../db.js";

// The day-60 card: one quiet image sent to the user and to each friend when a habit finishes.
// Drawn as SVG (easy to keep exact), rendered to PNG for iMessage.

export interface CardData {
  days: number;
  /** the line under "60 days.", e.g. “Stretch before training” or "Carl’s new habit." (callers keep it private where needed) */
  title: string;
  done: number;
  counted: number;
  longestStreak: number;
  /** one entry per day, in order */
  statuses: DayStatus[];
  /** last line, e.g. "With Anna and Leo" or "You stepped in 3 times. Part of this is yours." */
  footer: string;
}

const W = 1080, H = 1350;
const FONT = `"Helvetica Neue", "SF Pro Display", Inter, Arial, sans-serif`;
const INK = "#1D1D1F", GREY = "#86868B", BLUE = "#3B82F6", BG = "#F5F5F7", LIGHT = "#E5E5EA", LINE = "#D2D2D7";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Greedy wrap by an approximate character width; enough for short titles. */
function wrap(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur ? cur.length + 1 : 0) + w.length > maxChars && cur) { lines.push(cur); cur = w; }
    else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, "") + "…"; }
  return lines;
}

export function cardSvg(d: CardData): string {
  const x = 96;
  const title = wrap(d.title, 30, 2);
  let y = 330;
  const parts: string[] = [];
  parts.push(`<text x="${x}" y="150" font-size="34" font-weight="600" fill="${GREY}">Let’sGrow</text>`);
  parts.push(`<text x="${x}" y="${y}" font-size="150" font-weight="700" fill="${INK}" letter-spacing="-4">${d.days} days.</text>`);
  for (const line of title) { y += 72; parts.push(`<text x="${x}" y="${y}" font-size="54" font-weight="500" fill="${INK}" letter-spacing="-1">${esc(line)}</text>`); }
  y += 78;
  parts.push(`<text x="${x}" y="${y}" font-size="46" font-weight="600" fill="${BLUE}">${d.done} of ${d.counted || d.days} days on target.</text>`);

  // One dot per day: filled = done, light = missed, ring = didn't apply or no data.
  const cols = 10, r = 26, gap = 36, step = 2 * r + gap;
  const rows = Math.ceil(d.days / cols);
  const gridTop = y + 70;
  for (let i = 0; i < d.days; i++) {
    const cx = x + r + (i % cols) * step, cy = gridTop + r + Math.floor(i / cols) * step;
    const s = d.statuses[i];
    if (s === "done") parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${INK}"/>`);
    else if (s === "missed") parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${LIGHT}"/>`);
    else parts.push(`<circle cx="${cx}" cy="${cy}" r="${r - 1.5}" fill="none" stroke="${LINE}" stroke-width="3"/>`);
  }
  const bottom = gridTop + rows * step - gap;
  parts.push(`<text x="${x}" y="${Math.min(bottom + 90, H - 120)}" font-size="34" fill="${GREY}">Longest streak ${d.longestStreak} day${d.longestStreak === 1 ? "" : "s"}</text>`);
  wrap(d.footer, 48, 2).forEach((line, i) =>
    parts.push(`<text x="${x}" y="${Math.min(bottom + 140, H - 70) + i * 46}" font-size="34" fill="${INK}">${esc(line)}</text>`));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family='${FONT}'>
<rect width="${W}" height="${H}" fill="${BG}"/>${parts.join("")}</svg>`;
}

export function renderCard(d: CardData): Buffer {
  const png = new Resvg(cardSvg(d), {
    fitTo: { mode: "width", value: W },
    font: { loadSystemFonts: true, defaultFontFamily: "Helvetica Neue" },
  }).render().asPng();
  return Buffer.from(png);
}
