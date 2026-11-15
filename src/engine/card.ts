import { Resvg } from "@resvg/resvg-js";
import type { DayStatus } from "../db.js";

// The day-60 card: one quiet, keepsake-like image sent to the user and to each friend when a habit
// finishes. Only the habit and the days themselves, plus a small nudge to pass it on.

export interface CardData {
  /** the line at the top, e.g. “Stretch before training” or "Carl’s new habit." (callers keep it private where needed) */
  title: string;
  /** one entry per day, in order */
  statuses: DayStatus[];
}

const W = 1080, H = 1350;
const FONT = `"Helvetica Neue", "SF Pro Display", Inter, Arial, sans-serif`;
const BG = "#0B0B0C", INK = "#F4EFE6", GOLD = "#C9A45C", GOLD_LIGHT = "#F3E3B5", DIM = "#1D1D20", HAIR = "#2E2E32";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function wrap(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && cur.length + 1 + w.length > maxChars) { lines.push(cur); cur = w; } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, "") + "…"; }
  return lines;
}

export function cardSvg(d: CardData): string {
  const cx = W / 2;
  const parts: string[] = [];

  // Title, centred, at most two lines. The whole composition is centred vertically.
  const lines = wrap(d.title, 26, 2);
  const n = d.statuses.length || 60;
  const cols = 10, r = 30, step = 84;
  const rows = Math.ceil(n / cols);
  const blockH = 44 + (lines.length - 1) * 72 + 70 + 110 + (rows - 1) * step + 2 * r + 150 + 44;
  const titleTop = Math.round((H - blockH) / 2) + 44;
  lines.forEach((l, i) => parts.push(`<text x="${cx}" y="${titleTop + i * 72}" text-anchor="middle" font-size="60" font-weight="600" letter-spacing="-1.2" fill="${INK}">${esc(l)}</text>`));
  const ruleY = titleTop + (lines.length - 1) * 72 + 70;
  parts.push(`<line x1="${cx - 28}" y1="${ruleY}" x2="${cx + 28}" y2="${ruleY}" stroke="${GOLD}" stroke-width="2" stroke-linecap="round"/>`);

  // The days: gold for done, a quiet disc for missed, a hairline ring for days that didn't count.
  const gridW = (cols - 1) * step + 2 * r;
  const x0 = (W - gridW) / 2 + r;
  const y0 = ruleY + 110 + r;
  for (let i = 0; i < n; i++) {
    const x = x0 + (i % cols) * step, y = y0 + Math.floor(i / cols) * step;
    const s = d.statuses[i];
    if (s === "done") parts.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="url(#gold)"/>`);
    else if (s === "missed") parts.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="${DIM}"/>`);
    else parts.push(`<circle cx="${x}" cy="${y}" r="${r - 1}" fill="none" stroke="${HAIR}" stroke-width="2"/>`);
  }

  // Pass it on: the iOS share glyph and two quiet words.
  const sy = y0 + (rows - 1) * step + r + 150;
  const g = `<g transform="translate(${cx - 14} ${sy - 40})" fill="none" stroke="${GOLD}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" opacity="0.9">
<path d="M8 14 H4 V38 H24 V14 H20"/><path d="M14 2 V25"/><path d="M8 8 L14 2 L20 8"/></g>`;
  parts.push(g);
  parts.push(`<text x="${cx}" y="${sy + 44}" text-anchor="middle" font-size="22" font-weight="500" letter-spacing="7" fill="${GOLD}" opacity="0.85">PASS IT ON</text>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family='${FONT}'>
<defs><radialGradient id="gold" cx="38%" cy="32%" r="75%"><stop offset="0%" stop-color="${GOLD_LIGHT}"/><stop offset="55%" stop-color="${GOLD}"/><stop offset="100%" stop-color="#8F6E33"/></radialGradient></defs>
<rect width="${W}" height="${H}" fill="${BG}"/>
<rect x="36" y="36" width="${W - 72}" height="${H - 72}" rx="44" fill="none" stroke="${GOLD}" stroke-opacity="0.28" stroke-width="1.5"/>
${parts.join("\n")}</svg>`;
}

export function renderCard(d: CardData): Buffer {
  const png = new Resvg(cardSvg(d), {
    fitTo: { mode: "width", value: W },
    font: { loadSystemFonts: true, defaultFontFamily: "Helvetica Neue" },
  }).render().asPng();
  return Buffer.from(png);
}
