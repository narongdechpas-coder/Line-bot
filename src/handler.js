// ตรรกะหลักของ webhook แยกจาก Netlify เพื่อให้ทดสอบได้โดยไม่ต้องต่อ LINE หรือ Claude จริง
import { verifySignature } from "./line.js";
import { hashUserId } from "./store.js";

export const RESUME_KEYWORD = "คุยกับบอท";
export const GROUP_ID_COMMAND = "/groupid";

export const TEXT = {
  welcome:
    "สวัสดีครับ ขอบคุณที่แอดเพื่อนนะครับ 🙏\nพิมพ์ถามเรื่องหลักสูตรได้เลย บอทจะช่วยตอบเบื้องต้น ถ้าเรื่องไหนตอบไม่ได้ แอดมินจะมาตอบต่อครับ\n\n(ระบบเก็บข้อความที่คุยกันไว้เพื่อปรับปรุงการตอบ)",
  nonText: "ตอนนี้บอทอ่านได้เฉพาะข้อความตัวอักษรครับ รบกวนพิมพ์คำถามเข้ามาได้เลยครับ",
  resumed: "กลับมาคุยกับบอทแล้วครับ ถามเรื่องหลักสูตรได้เลยครับ",
  groupId: (id) =>
    `Group ID ของกลุ่มนี้คือ\n${id}\n\nถ้าจะใช้กลุ่มนี้รับแจ้งเตือน ให้ใส่ค่านี้ใน Netlify เป็น ADMIN_GROUP_ID แล้ว deploy ใหม่`,
};

const ALERT_REASON = {
  handoff: "🔔 ลูกค้าขอคุยกับแอดมิน (บอทหยุดตอบห้องนี้ชั่วคราว)",
  not_in_data: "❓ บอทตอบไม่ได้ ข้อมูลไม่มีในไฟล์ (บอทยังตอบห้องนี้ต่อ)",
};

const msg = (deps, key) => deps.messages?.[key] ?? TEXT[key];

export function formatAlert({ status, name, question, at }) {
  const time = new Date(at).toLocaleString("th-TH", {
    timeZone: "Asia/Bangkok",
    dateStyle: "short",
    timeStyle: "short",
  });
  return `${ALERT_REASON[status]}\nชื่อ: ${name ?? "(ไม่ทราบชื่อ)"}\nข้อความ: ${question}\nเวลา: ${time}\n\nตอบได้ที่ OA Manager → Chat แล้วค้นจากชื่อนี้`;
}

// deps: { channelSecret, salt, line, answer, store, messages?, adminGroupId?, waitUntil?, now? }
// messages มาจากหัวข้อ "ข้อความตายตัว" ใน persona.md ถ้าไม่มี ใช้ TEXT ด้านบน
export async function handleWebhook({ rawBody, signature }, deps) {
  if (!verifySignature(rawBody, signature, deps.channelSecret)) {
    return { status: 401, body: "invalid signature" };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: "invalid json" };
  }

  // ตอนกด Verify ใน LINE Developers Console จะส่ง events ว่างมา ต้องตอบ 200
  for (const event of payload.events ?? []) {
    try {
      if (event.source?.type === "group" || event.source?.type === "room") {
        await handleGroupEvent(event, deps);
      } else if (event.source?.type === "user") {
        await handleUserEvent(event, deps);
      }
    } catch (err) {
      // event หนึ่งพัง ไม่ให้กระทบ event อื่น และยังตอบ 200 ให้ LINE
      console.error("event failed:", err?.message ?? err);
    }
  }
  return { status: 200, body: "ok" };
}

// ในกลุ่ม บอทไม่ตอบคำถามใดๆ ทำแค่บอก Group ID ตอนถูกเชิญ หรือเมื่อมีคนพิมพ์ /groupid
async function handleGroupEvent(event, { line }) {
  const id = event.source.groupId ?? event.source.roomId;
  const asked = event.type === "message" && event.message?.type === "text" && event.message.text.trim() === GROUP_ID_COMMAND;
  if (event.type === "join" || asked) {
    await line.reply(event.replyToken, TEXT.groupId(id));
  }
}

async function handleUserEvent(event, deps) {
  const { line, store, answer, salt } = deps;
  const userId = event.source.userId;
  if (!userId) return;
  const uid = hashUserId(userId, salt);
  const later = (p) => (deps.waitUntil ? deps.waitUntil(p) : p);

  if (event.type === "follow") {
    await line.reply(event.replyToken, msg(deps, "welcome"));
    return;
  }
  if (event.type !== "message") return;

  if (event.message?.type !== "text") {
    await line.reply(event.replyToken, msg(deps, "nonText"));
    return;
  }

  const text = event.message.text.trim();

  // ระหว่างส่งต่อแอดมิน บอทเงียบ จะได้ไม่ตอบแย่งกับแอดมิน (ไม่แจ้งเตือนซ้ำ แอดมินเห็นในห้องแชทอยู่แล้ว)
  if (await store.isHandoff(uid)) {
    if (text === RESUME_KEYWORD) {
      await store.clearHandoff(uid);
      await line.reply(event.replyToken, msg(deps, "resumed"));
      return;
    }
    await later(store.log({ uid, question: text, answer: null, status: "muted" }));
    return;
  }

  await line.showLoading(userId);
  const history = await store.getHistory(uid);
  const result = await answer(history, text);

  // ตอบลูกค้าก่อน แล้วค่อยทำงานเบื้องหลัง ไม่ให้ถ่วงเวลาตอบ
  await line.reply(event.replyToken, result.reply);

  const tasks = [
    store.log({
      uid,
      question: text,
      answer: result.reply,
      status: result.status,
      usage: result.usage
        ? {
            input: result.usage.input_tokens,
            output: result.usage.output_tokens,
            cacheRead: result.usage.cache_read_input_tokens ?? 0,
          }
        : undefined,
    }),
  ];
  if (result.status !== "error") tasks.push(store.appendHistory(uid, text, result.reply));
  if (result.status === "handoff") tasks.push(store.setHandoff(uid));
  if (ALERT_REASON[result.status]) tasks.push(alertAdmin(deps, userId, result.status, text));
  await later(Promise.all(tasks));
}

async function alertAdmin({ line, adminGroupId, now = () => Date.now() }, userId, status, question) {
  if (!adminGroupId) {
    console.warn(`ยังไม่ได้ตั้ง ADMIN_GROUP_ID จึงไม่ได้แจ้งเตือนแอดมิน (status: ${status})`);
    return;
  }
  try {
    const name = await line.getDisplayName(userId);
    await line.push(adminGroupId, formatAlert({ status, name, question, at: now() }));
  } catch (err) {
    console.error("alertAdmin failed:", err?.message ?? err);
  }
}
