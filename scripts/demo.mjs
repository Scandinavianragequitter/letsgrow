// npm run demo: start a Cloudflare quick tunnel, then the app with PUBLIC_BASE_URL set to the
// tunnel's address, so friend links work on anyone's phone. Everything still runs on this machine.
// Needs cloudflared (macOS: brew install cloudflared). Ctrl-C stops both.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import QRCode from "qrcode";

const port = process.env.PORT || "3000";
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

const tunnel = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
tunnel.on("error", (err) => {
  if (err.code === "ENOENT") console.error("cloudflared is not installed. On macOS: brew install cloudflared");
  else console.error("could not start cloudflared:", err.message);
  process.exit(1);
});

let app;
const timeout = setTimeout(() => {
  console.error("cloudflared did not print a tunnel address within 45s. Check your connection and try again.");
  shutdown(1);
}, 45_000);

function onOutput(chunk) {
  const url = !app && String(chunk).match(URL_RE)?.[0];
  if (!url) return;
  clearTimeout(timeout);
  QRCode.toString(url, { type: "terminal", small: true }).then((qr) => {
    console.log(`\n${qr}\n  Let'sGrow is public at ${url}\n  Scan the code above, or open ${url}/qr for a full-screen one.\n  Open that address (not localhost) so friend links use it.\n`);
  });
  const args = ["tsx", ...(existsSync(".env") ? ["--env-file=.env"] : []), "src/main.ts"];
  // A variable already in the environment wins over .env, so this overrides PUBLIC_BASE_URL there.
  app = spawn("npx", args, { stdio: "inherit", env: { ...process.env, PUBLIC_BASE_URL: url, PORT: port } });
  app.on("exit", (code) => shutdown(code ?? 0));
}
tunnel.stdout.on("data", onOutput);
tunnel.stderr.on("data", onOutput);
tunnel.on("exit", (code) => {
  if (app) console.error(`\ncloudflared stopped (code ${code}). The public address no longer works.`);
  shutdown(code ?? 1);
});

let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  clearTimeout(timeout);
  app?.kill("SIGINT");
  tunnel.kill("SIGINT");
  setTimeout(() => process.exit(code), 500);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
