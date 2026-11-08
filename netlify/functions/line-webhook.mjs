// Netlify Function: รับ webhook จาก LINE ที่ https://<ชื่อเว็บ>.netlify.app/webhook
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleWebhook } from "../../src/handler.js";
import { createLineClient } from "../../src/line.js";
import { createBot } from "../../src/bot.js";
import { createStore, netlifyKv } from "../../src/store.js";

export const config = { path: "/webhook" };

function readData(file, { required }) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(process.cwd(), "data", file),
    path.resolve(here, "../../data", file),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
  }
  const msg = `ไม่พบ data/${file} (ลองหาที่: ${candidates.join(", ")})`;
  if (required) throw new Error(msg);
  console.warn(`${msg} จะใช้ persona ค่าเริ่มต้นแทน`);
  return "";
}

// สร้างครั้งเดียวต่อ instance แล้วใช้ซ้ำ
let deps;
async function getDeps() {
  if (deps) return deps;
  const env = process.env;
  for (const name of ["LINE_CHANNEL_SECRET", "LINE_CHANNEL_ACCESS_TOKEN", "ANTHROPIC_API_KEY"]) {
    if (!env[name]) throw new Error(`ยังไม่ได้ตั้ง environment variable: ${name}`);
  }
  deps = {
    channelSecret: env.LINE_CHANNEL_SECRET,
    adminGroupId: env.ADMIN_GROUP_ID || undefined,
    salt: env.HASH_SALT ?? "",
    line: createLineClient(env.LINE_CHANNEL_ACCESS_TOKEN),
    answer: createBot({
      apiKey: env.ANTHROPIC_API_KEY,
      coursesText: readData("courses.md", { required: true }),
      personaText: readData("persona.md", { required: false }),
    }),
    store: createStore(await netlifyKv(), {
      historyTurns: Number(env.HISTORY_TURNS ?? 4),
      handoffMinutes: Number(env.HANDOFF_MINUTES ?? 60),
    }),
  };
  return deps;
}

export default async (req, context) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const rawBody = await req.text();
  const d = await getDeps();
  const result = await handleWebhook(
    { rawBody, signature: req.headers.get("x-line-signature") },
    // ถ้า runtime รองรับ waitUntil จะเขียน log หลังส่ง response ได้ ถ้าไม่รองรับก็รอให้เสร็จก่อนตามปกติ
    { ...d, waitUntil: context?.waitUntil?.bind(context) },
  );
  return new Response(result.body, { status: result.status });
};
