# line-bot

บอท LINE OA ตอบคำถามเรื่องหลักสูตร โดยใช้ข้อมูลจาก `data/courses.md` รันบน Netlify Functions และ Claude API (`claude-haiku-5-5`)

## โครงไฟล์

| ไฟล์ | หน้าที่ |
|---|---|
| `data/courses.md` | **ข้อมูลหลักสูตร แก้ไฟล์นี้ไฟล์เดียวเมื่อข้อมูลเปลี่ยน** (ตอนนี้เป็นข้อมูลสมมติ) |
| `netlify/functions/line-webhook.mjs` | จุดรับ webhook ที่ `/webhook` |
| `src/handler.js` | ตรรกะหลัก: ตรวจลายเซ็น, ตอบ, ส่งต่อแอดมิน, เขียน log |
| `src/bot.js` | กติกาของบอท (system prompt) และการเรียก Claude |
| `src/line.js` | ส่งข้อความกลับ LINE, ตรวจลายเซ็น |
| `src/store.js` | เก็บ history, สถานะส่งต่อแอดมิน, log ลง Netlify Blobs |
| `test/` | ชุดทดสอบ (`npm test`) |

## ตั้งค่าครั้งแรก

1. **Netlify**: Add new site → Import from GitHub → เลือก repo นี้ (ค่า build ใช้จาก `netlify.toml` ได้เลย)
2. **Environment variables** (Site configuration → Environment variables)
   - `LINE_CHANNEL_SECRET` — LINE Developers Console → Basic settings
   - `LINE_CHANNEL_ACCESS_TOKEN` — Messaging API → Channel access token (long-lived)
   - `ANTHROPIC_API_KEY` — จาก console.anthropic.com
   - `HASH_SALT` — ข้อความสุ่มยาวๆ ตั้งครั้งเดียวแล้วอย่าเปลี่ยน
   - `ADMIN_GROUP_ID` — ได้จากขั้นที่ 6 (ใส่ทีหลังได้ ระหว่างนี้บอทยังตอบลูกค้าตามปกติ แค่ยังไม่แจ้งเตือนแอดมิน)
   - ไม่บังคับ: `HISTORY_TURNS` (ค่าเริ่มต้น 4), `HANDOFF_MINUTES` (ค่าเริ่มต้น 60)
3. **Deploy ใหม่** หลังตั้ง env (Deploys → Trigger deploy)
4. **LINE Developers Console → Messaging API**
   - Webhook URL: `https://<ชื่อเว็บ>.netlify.app/webhook` → กด Verify ต้องขึ้น Success
   - เปิด Use webhook
   - **ปิด Webhook redelivery** กันบอทตอบซ้ำตอน function ตอบช้า
5. **LINE Official Account Manager → Response settings**: ปิด Auto-response และ Greeting message (บอทส่งข้อความต้อนรับเองแล้ว ไม่อย่างนั้นลูกค้าจะได้สองชุด) ส่วน Chat เปิดไว้ แอดมินจะได้ตอบเองตอนส่งต่อ
6. **กลุ่มแจ้งเตือนแอดมิน**
   - เปิดให้ OA เข้ากลุ่มได้ (OA Manager → Settings → Account settings → อนุญาตให้เข้าร่วมกลุ่ม ชื่อเมนูอาจต่างไปตามเวอร์ชัน)
   - สร้างกลุ่ม LINE ของแอดมิน แล้วเชิญ OA เข้ากลุ่ม บอทจะส่ง Group ID มาในกลุ่ม (พิมพ์ `/groupid` เพื่อขอใหม่ได้)
   - เอา Group ID ไปใส่เป็น `ADMIN_GROUP_ID` ใน Netlify แล้ว deploy ใหม่

## บอททำงานยังไง

- ตอบจาก `data/courses.md` เท่านั้น ถ้าข้อมูลไม่มี จะบอกว่าให้แอดมินตอบ และติดสถานะ `not_in_data` ใน log
- ถ้าลูกค้าขอคุยกับคน ร้องเรียน หรือมีปัญหาการชำระเงิน บอทจะติดสถานะ `handoff` แล้ว **เงียบไป `HANDOFF_MINUTES` นาที** แอดมินตอบผ่าน OA Manager ได้โดยไม่มีบอทแย่งตอบ ลูกค้าพิมพ์ `คุยกับบอท` เพื่อเรียกบอทกลับมาก่อนเวลาได้
- จำบทสนทนาย้อนหลัง `HISTORY_TURNS` รอบ ถ้าเงียบเกิน 30 นาทีจะเริ่มเรื่องใหม่
- **แจ้งเตือนแอดมิน**: เมื่อติด `handoff` หรือ `not_in_data` บอทจะ push ข้อความเข้ากลุ่มแอดมิน บอกชื่อ LINE ของลูกค้า ข้อความ และเวลา แอดมินไปค้นชื่อนั้นใน OA Manager → Chat แล้วตอบได้เลย ระหว่าง handoff จะแจ้งครั้งเดียว ไม่แจ้งซ้ำทุกข้อความ การ push นับโควต้าข้อความของ OA แต่ส่งเฉพาะเคสที่ต้องให้คนตอบ ชื่อลูกค้าใช้ในข้อความแจ้งเตือนเท่านั้น ไม่เก็บลง log
- ในกลุ่ม บอทไม่ตอบคำถามใดๆ ตอบแค่ตอนถูกเชิญ และเมื่อมีคนพิมพ์ `/groupid`
- ถ้า Claude ตอบไม่ทันหรือ error ลูกค้าจะได้ข้อความสำรองว่าแอดมินจะตอบกลับ (สถานะ `error`)

## Log

ทุกข้อความเก็บใน Netlify Blobs (store `line-bot`) key รูปแบบ `log/YYYY-MM-DD/...` มีเวลา, userId ที่ hash แล้ว, คำถาม, คำตอบ, สถานะ, จำนวน token ดูได้ใน Netlify → Blobs ระหว่างที่ยังไม่มีหน้า `/admin`

> ยังไม่มีระบบลบ log อัตโนมัติ แผนคือทำพร้อมหน้า admin (ลบ log ที่เก่ากว่า 90 วัน)

## ทดสอบ

```bash
npm install
npm test
```
