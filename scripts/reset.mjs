// Fresh start.
//   npm run reset                 wipe everything (stop the server first)
//   npm run reset -- +15551234567 clear one person's habits, friends and chats (keeps their account)
import { existsSync, rmSync } from "node:fs";

const db = process.env.DB_PATH ?? "./data/letsgrow.db";
const phone = process.argv[2];

if (!phone) {
  const files = [db, `${db}-wal`, `${db}-shm`].filter(existsSync);
  files.forEach((f) => rmSync(f));
  console.log(files.length ? `Wiped ${db}. Start fresh with npm run demo.` : "Nothing to wipe.");
  process.exit(0);
}

if (!existsSync(db)) { console.log("No database yet."); process.exit(0); }
const { Store } = await import("../src/db.ts");
const { normalizePhone } = await import("../src/phone.ts");
const store = new Store(db);
const user = store.getUserByPhone(normalizePhone(phone) ?? "");
if (!user) { console.log(`No account for ${phone}.`); process.exit(1); }
const r = store.resetHabits(user.id);
console.log(`Cleared ${user.name}: ${r.habits} habit(s), ${r.friends} friend(s), chats. Account and connections kept.`);
