// เก็บประวัติแชทสั้นๆ สถานะส่งต่อแอดมิน และ log ทุกข้อความ
// ใช้ Netlify Blobs บน production และ memory store ตอนทดสอบ
import crypto from "node:crypto";

const HISTORY_TTL_MS = 30 * 60 * 1000; // คุยห่างเกิน 30 นาที ถือว่าเริ่มเรื่องใหม่

export function hashUserId(userId, salt = "") {
  return crypto.createHash("sha256").update(`${salt}:${userId}`).digest("hex").slice(0, 32);
}

// kv ต้องมี get(key) -> object|null และ set(key, object)
export function createStore(kv, { historyTurns = 4, handoffMinutes = 60, now = () => Date.now() } = {}) {
  return {
    async getHistory(uid) {
      const data = await kv.get(`history/${uid}`);
      if (!data || now() - data.updatedAt > HISTORY_TTL_MS) return [];
      return data.messages;
    },

    async appendHistory(uid, userText, botText) {
      const prev = await this.getHistory(uid);
      const messages = [
        ...prev,
        { role: "user", content: userText },
        { role: "assistant", content: botText },
      ].slice(-historyTurns * 2); // เก็บแค่ N รอบล่าสุด กันค่า token บาน
      await kv.set(`history/${uid}`, { messages, updatedAt: now() });
    },

    async isHandoff(uid) {
      const data = await kv.get(`handoff/${uid}`);
      return Boolean(data && data.until > now());
    },

    async setHandoff(uid) {
      await kv.set(`handoff/${uid}`, { until: now() + handoffMinutes * 60 * 1000 });
    },

    async clearHandoff(uid) {
      await kv.set(`handoff/${uid}`, { until: 0 });
    },

    // key ขึ้นต้นด้วยวันที่ จะได้ list ตามวันได้ตอนทำหน้า admin
    async log(entry) {
      const t = new Date(now());
      const day = t.toISOString().slice(0, 10);
      const key = `log/${day}/${t.getTime()}-${crypto.randomBytes(3).toString("hex")}`;
      await kv.set(key, { at: t.toISOString(), ...entry });
    },
  };
}

// ตัวเก็บข้อมูลแบบ Netlify Blobs
export async function netlifyKv(storeName = "line-bot") {
  const { getStore } = await import("@netlify/blobs");
  const store = getStore(storeName);
  return {
    get: (key) => store.get(key, { type: "json" }),
    set: (key, value) => store.setJSON(key, value),
  };
}

// ตัวเก็บข้อมูลใน memory สำหรับทดสอบ
export function memoryKv() {
  const map = new Map();
  return {
    map,
    get: async (key) => (map.has(key) ? structuredClone(map.get(key)) : null),
    set: async (key, value) => void map.set(key, structuredClone(value)),
  };
}
