// ฟังก์ชันคุยกับ LINE Messaging API
import crypto from "node:crypto";

const LINE_API = "https://api.line.me/v2/bot";

// ตรวจว่า request มาจาก LINE จริง: HMAC-SHA256 ของ body ดิบ ด้วย channel secret แล้วเทียบกับ header x-line-signature
export function verifySignature(rawBody, signature, channelSecret) {
  if (!signature || !channelSecret) return false;
  const expected = crypto
    .createHmac("sha256", channelSecret)
    .update(rawBody)
    .digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createLineClient(accessToken, fetchImpl = fetch) {
  async function call(path, body, method = "POST") {
    const res = await fetchImpl(`${LINE_API}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`LINE API ${path} ${res.status}: ${text}`);
    }
    return res;
  }

  return {
    // ชื่อที่ลูกค้าตั้งใน LINE ใช้ตอนแจ้งเตือนแอดมินเท่านั้น ไม่เก็บลง log
    async getDisplayName(userId) {
      try {
        const res = await call(`/profile/${encodeURIComponent(userId)}`, undefined, "GET");
        const data = await res.json();
        return data.displayName || null;
      } catch (err) {
        console.warn("getProfile failed:", err.message);
        return null;
      }
    },
    // push นับโควต้าข้อความของ OA ใช้เฉพาะแจ้งเตือนแอดมิน
    async push(to, text) {
      await call("/message/push", {
        to,
        messages: [{ type: "text", text: text.slice(0, 5000) }],
      });
    },
    // จุดสามจุด "กำลังพิมพ์" ใช้ได้เฉพาะแชทตัวต่อตัว จึงไม่ต้องให้ error ตรงนี้ทำให้บอทล่ม
    async showLoading(userId, seconds = 20) {
      try {
        await call("/chat/loading/start", { chatId: userId, loadingSeconds: seconds });
      } catch (err) {
        console.warn("showLoading failed:", err.message);
      }
    },
    // reply ไม่นับโควต้าข้อความ แต่ replyToken ใช้ได้ครั้งเดียวและหมดอายุเร็ว
    async reply(replyToken, text) {
      await call("/message/reply", {
        replyToken,
        messages: [{ type: "text", text: text.slice(0, 5000) }],
      });
    },
  };
}
