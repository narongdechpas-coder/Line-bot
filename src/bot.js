// ส่วนที่คุยกับ Claude: ประกอบ system prompt จากไฟล์ข้อมูลหลักสูตร แล้วขอคำตอบเป็น JSON
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

export const MODEL = "claude-haiku-5-5";

// Claude ต้องตอบกลับมาในรูปนี้เสมอ เพื่อให้เรากรอง log ได้ว่าคำถามไหนข้อมูลยังไม่ครอบคลุม
export const ReplySchema = z.object({
  reply: z.string(),
  status: z.enum(["answered", "not_in_data", "handoff"]),
});

const RULES = `คุณคือแอดมิน LINE OA ที่ตอบคำถามเรื่องหลักสูตร

กติกา:
- ตอบจาก "ข้อมูลหลักสูตร" ด้านล่างเท่านั้น ห้ามเดาหรือแต่งข้อมูลเพิ่ม โดยเฉพาะราคา ส่วนลด วันเวลา ลิงก์ เลขบัญชี และเงื่อนไขการคืนเงิน
- ถ้าคำถามไม่มีคำตอบในข้อมูล ให้บอกสุภาพว่าเรื่องนี้ขอให้แอดมินตอบ แล้วตั้ง status เป็น "not_in_data"
- ถ้าลูกค้าขอคุยกับคน ร้องเรียน มีปัญหาการชำระเงิน หรือเรื่องที่ต้องตัดสินใจเฉพาะราย ให้ตั้ง status เป็น "handoff" และบอกว่าแอดมินจะตอบกลับ
- นอกนั้นตั้ง status เป็น "answered"
- ตอบภาษาไทย สั้น กระชับ เป็นกันเอง เหมาะกับแชทมือถือ ไม่ใช้ markdown (LINE ไม่แสดงตัวหนาหรือหัวข้อ)
- ถ้าลูกค้าพิมพ์ภาษาอื่น ให้ตอบเป็นภาษานั้น`;

export function buildSystem(coursesText) {
  return [
    {
      type: "text",
      text: `${RULES}\n\n<ข้อมูลหลักสูตร>\n${coursesText}\n</ข้อมูลหลักสูตร>`,
      // ส่วนนี้เหมือนเดิมทุกข้อความ จึง cache ได้ ถ้าสั้นกว่าขั้นต่ำของโมเดล API จะไม่ cache ให้เองโดยไม่ error
      cache_control: { type: "ephemeral" },
    },
  ];
}

export const FALLBACK_REPLY =
  "ขออภัยครับ ระบบตอบอัตโนมัติขัดข้องชั่วคราว แอดมินจะตอบกลับโดยเร็วที่สุดครับ";

export function createBot({ apiKey, coursesText, timeoutMs = 7000, client }) {
  const anthropic = client ?? new Anthropic({ apiKey });
  const system = buildSystem(coursesText);

  // history: [{role:"user"|"assistant", content:string}, ...] ต้องขึ้นต้นด้วย user
  return async function answer(history, userText) {
    try {
      const response = await anthropic.messages.parse(
        {
          model: MODEL,
          max_tokens: 1024,
          // งานตอบจากข้อมูลที่ให้ไป ไม่ต้องคิดลึก ปิด thinking และใช้ effort ต่ำเพื่อให้ตอบทันเวลาของ function
          thinking: { type: "disabled" },
          output_config: { effort: "low", format: zodOutputFormat(ReplySchema) },
          system,
          messages: [...history, { role: "user", content: userText }],
        },
        // Netlify function มีเวลาจำกัด จึงไม่ retry และตัดที่ timeoutMs
        { timeout: timeoutMs, maxRetries: 0 },
      );

      if (response.stop_reason === "refusal" || !response.parsed_output) {
        return { reply: FALLBACK_REPLY, status: "error", usage: response.usage };
      }
      return { ...response.parsed_output, usage: response.usage };
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) {
        console.error("Claude rate limited");
      } else if (err instanceof Anthropic.APIError) {
        console.error(`Claude API error ${err.status}:`, err.message);
      } else {
        console.error("Claude call failed:", err?.message ?? err);
      }
      return { reply: FALLBACK_REPLY, status: "error" };
    }
  };
}
