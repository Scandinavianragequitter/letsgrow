import { Resvg } from "@resvg/resvg-js";
import type { DayStatus } from "../db.js";

// The day-60 card: a keepsake ticket sent to the user and to each friend when a habit finishes.
// The habit, the days, and the dates it ran. Nothing else.

export interface CardData {
  /** the line at the top, e.g. “Stretch before training” or "Carl’s new habit." (callers keep it private where needed) */
  title: string;
  /** one entry per day, in order */
  statuses: DayStatus[];
  /** first and last day, YYYY-MM-DD */
  from: string;
  to: string;
}

const W = 1080, H = 1350;
// The renderer only uses the first font it's given (no fallback lists, no generic names), so name one per platform.
const MAC = process.platform === "darwin";
const SANS = MAC ? "Helvetica Neue" : "Inter";
const MONO = MAC ? "Menlo" : "DejaVu Sans Mono";
const PAGE = "#1C1612", TICKET = "#0E0C0A", INK = "#F4EFE6", GOLD = "#C9A45C", GOLD_LIGHT = "#F3E3B5", DIM = "#2C2621", HAIR = "#3A3128";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
export const ticketDate = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
};

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
  // Ticket body with a tear-off stub at the bottom.
  const L = 64, R = W - 64, T = 64, B = H - 64, rad = 40;
  const tear = 1084, notch = 28;
  const x = 132;
  const parts: string[] = [];

  // Title, top left.
  const lines = wrap(d.title, 26, 2);
  lines.forEach((l, i) => parts.push(`<text x="${x}" y="${232 + i * 72}" font-family="${SANS}" font-size="60" font-weight="600" letter-spacing="-1.2" fill="${INK}">${esc(l)}</text>`));

  // The days: gold for done, a quiet disc for missed, a hairline ring for days that didn't count.
  const n = d.statuses.length || 60;
  const cols = 10, r = 30, step = 84;
  const rows = Math.ceil(n / cols);
  // centre the grid between the title and the tear line
  const titleBottom = 232 + (lines.length - 1) * 72 + 20;
  const gridH = (rows - 1) * step + 2 * r;
  const y0 = Math.round(titleBottom + (tear - titleBottom - gridH) / 2) + r;
  for (let i = 0; i < n; i++) {
    const cx = x + r + (i % cols) * step, cy = y0 + Math.floor(i / cols) * step;
    const s = d.statuses[i];
    if (s === "done") parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#gold)"/>`);
    else if (s === "missed") parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${DIM}"/>`);
    else parts.push(`<circle cx="${cx}" cy="${cy}" r="${r - 1}" fill="none" stroke="${HAIR}" stroke-width="2"/>`);
  }

  // Stub: the dates it ran, with a ghosted day count behind them.
  const stubMid = (tear + B) / 2;
  parts.push(`<text x="${R - 70}" y="${stubMid + 66}" text-anchor="end" font-family="${SANS}" font-size="190" font-weight="700" letter-spacing="-6" fill="${GOLD}" fill-opacity="0.09">${n}</text>`);
  parts.push(`<text x="${x}" y="${stubMid + 11}" font-family="${MONO}" font-size="26" letter-spacing="2" fill="${INK}">${ticketDate(d.from)} – ${ticketDate(d.to)}</text>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
  <radialGradient id="gold" cx="38%" cy="32%" r="75%"><stop offset="0%" stop-color="${GOLD_LIGHT}"/><stop offset="55%" stop-color="${GOLD}"/><stop offset="100%" stop-color="#8F6E33"/></radialGradient>
  <radialGradient id="glow" cx="88%" cy="6%" r="70%"><stop offset="0%" stop-color="${GOLD}" stop-opacity="0.22"/><stop offset="100%" stop-color="${GOLD}" stop-opacity="0"/></radialGradient>
  <filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" result="n"/><feColorMatrix in="n" type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope="0.07"/></feComponentTransfer><feComposite in2="SourceGraphic" operator="in"/></filter>
  <mask id="ticket"><rect x="${L}" y="${T}" width="${R - L}" height="${B - T}" rx="${rad}" fill="#fff"/><circle cx="${L}" cy="${tear}" r="${notch}" fill="#000"/><circle cx="${R}" cy="${tear}" r="${notch}" fill="#000"/></mask>
</defs>
<rect width="${W}" height="${H}" fill="${PAGE}"/>
<g mask="url(#ticket)">
  <rect x="${L}" y="${T}" width="${R - L}" height="${B - T}" fill="${TICKET}"/>
  <rect x="${L}" y="${T}" width="${R - L}" height="${B - T}" fill="url(#glow)"/>
  <rect x="${L}" y="${T}" width="${R - L}" height="${B - T}" fill="#fff" filter="url(#grain)"/>
</g>
<line x1="${L + notch + 22}" y1="${tear}" x2="${R - notch - 22}" y2="${tear}" stroke="${HAIR}" stroke-width="2" stroke-dasharray="2 12" stroke-linecap="round"/>
${parts.join("\n")}</svg>`;
}

export function renderCard(d: CardData): Buffer {
  const png = new Resvg(cardSvg(d), {
    fitTo: { mode: "width", value: W },
    font: { loadSystemFonts: true, defaultFontFamily: SANS },
  }).render().asPng();
  return Buffer.from(png);
}
