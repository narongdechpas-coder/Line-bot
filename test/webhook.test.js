import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { handleWebhook, RESUME_KEYWORD, TEXT, GROUP_ID_COMMAND } from "../src/handler.js";
import { verifySignature } from "../src/line.js";
import { createStore, memoryKv } from "../src/store.js";
import { createBot, buildSystem, FALLBACK_REPLY, MODEL } from "../src/bot.js";
import fs from "node:fs";
import { parsePersona, MESSAGE_KEYS } from "../src/persona.js";

const SECRET = "test-channel-secret";
const sign = (body) => crypto.createHmac("sha256", SECRET).update(body).digest("base64");

function textEvent(text, userId = "U123", replyToken = "rt-1") {
  return {
    type: "message",
    replyToken,
    source: { type: "user", userId },
    message: { type: "text", id: "m1", text },
  };
}

function setup({ answer, adminGroupId = "Cadmin", displayName = "สมชาย" } = {}) {
  const replies = [];
  const pushes = [];
  const loading = [];
  const kv = memoryKv();
  const store = createStore(kv);
  const calls = [];
  const deps = {
    channelSecret: SECRET,
    salt: "s",
    adminGroupId,
    store,
    line: {
      reply: async (token, text) => void replies.push({ token, text }),
      push: async (to, text) => void pushes.push({ to, text }),
      getDisplayName: async () => displayName,
      showLoading: async (uid) => void loading.push(uid),
    },
    answer:
      answer ??
      (async (history, text) => {
        calls.push({ history, text });
        return { reply: `ตอบ: ${text}`, status: "answered" };
      }),
  };
  const send = (events) => {
    const rawBody = JSON.stringify({ destination: "x", events });
    return handleWebhook({ rawBody, signature: sign(rawBody) }, deps);
  };
  return { deps, replies, pushes, loading, kv, store, calls, send };
}

const logs = (kv) => [...kv.map].filter(([k]) => k.startsWith("log/")).map(([, v]) => v);

test("ตรวจ signature ถูกและผิด", () => {
  const body = '{"events":[]}';
  assert.equal(verifySignature(body, sign(body), SECRET), true);
  assert.equal(verifySignature(body, sign(body + " "), SECRET), false);
  assert.equal(verifySignature(body, undefined, SECRET), false);
});

test("signature ผิดได้ 401 และไม่ตอบอะไร", async () => {
  const { deps, replies } = setup();
  const res = await handleWebhook({ rawBody: '{"events":[]}', signature: "bad" }, deps);
  assert.equal(res.status, 401);
  assert.equal(replies.length, 0);
});

test("ปุ่ม Verify ของ LINE (events ว่าง) ได้ 200", async () => {
  const { send } = setup();
  assert.equal((await send([])).status, 200);
});

test("ข้อความปกติ: โชว์ loading, ตอบ, เก็บ history และ log", async () => {
  const { send, replies, loading, kv, calls } = setup();
  const res = await send([textEvent("คอร์ส A ราคาเท่าไหร่")]);
  assert.equal(res.status, 200);
  assert.deepEqual(loading, ["U123"]);
  assert.deepEqual(replies, [{ token: "rt-1", text: "ตอบ: คอร์ส A ราคาเท่าไหร่" }]);
  assert.deepEqual(calls[0].history, []);

  const [log] = logs(kv);
  assert.equal(log.status, "answered");
  assert.equal(log.question, "คอร์ส A ราคาเท่าไหร่");
  assert.ok(!JSON.stringify(log).includes("U123"), "log ต้องไม่มี userId จริง");

  await send([textEvent("แล้วเรียนกี่ชั่วโมง", "U123", "rt-2")]);
  assert.equal(calls[1].history.length, 2);
  assert.equal(calls[1].history[0].role, "user");
});

test("history ตัดเหลือ N รอบล่าสุด และหมดอายุหลัง 30 นาที", async () => {
  let t = 1_000_000;
  const kv = memoryKv();
  const store = createStore(kv, { historyTurns: 2, now: () => t });
  for (let i = 1; i <= 5; i++) await store.appendHistory("u", `q${i}`, `a${i}`);
  const h = await store.getHistory("u");
  assert.deepEqual(h.map((m) => m.content), ["q4", "a4", "q5", "a5"]);
  t += 31 * 60 * 1000;
  assert.deepEqual(await store.getHistory("u"), []);
});

test("handoff: บอทเงียบจนกว่าจะพิมพ์คำปลดล็อก", async () => {
  let n = 0;
  const { send, replies, kv } = setup({
    answer: async () => (n++ === 0 ? { reply: "แอดมินจะตอบกลับครับ", status: "handoff" } : { reply: "ok", status: "answered" }),
  });
  await send([textEvent("ขอคุยกับคน")]);
  assert.equal(replies.length, 1);

  await send([textEvent("ฮัลโหล", "U123", "rt-2")]);
  assert.equal(replies.length, 1, "ระหว่าง handoff ต้องไม่ตอบ");
  assert.ok(logs(kv).some((l) => l.status === "muted"));

  await send([textEvent(RESUME_KEYWORD, "U123", "rt-3")]);
  assert.equal(replies.at(-1).text, TEXT.resumed);

  await send([textEvent("คอร์ส B เรียนวันไหน", "U123", "rt-4")]);
  assert.equal(replies.at(-1).text, "ok");
});

test("Claude error: ตอบข้อความสำรอง, log เป็น error, ไม่เก็บลง history", async () => {
  const { send, replies, kv, store } = setup({
    answer: async () => ({ reply: FALLBACK_REPLY, status: "error" }),
  });
  await send([textEvent("สวัสดี")]);
  assert.equal(replies[0].text, FALLBACK_REPLY);
  assert.equal(logs(kv)[0].status, "error");
  const uid = [...kv.map.keys()].find((k) => k.startsWith("history/"));
  assert.equal(uid, undefined);
  void store;
});

test("สติกเกอร์/รูป ได้ข้อความแจ้ง, follow ได้ข้อความต้อนรับ", async () => {
  const { send, replies } = setup();
  await send([
    { type: "message", replyToken: "a", source: { type: "user", userId: "U1" }, message: { type: "sticker" } },
    { type: "follow", replyToken: "b", source: { type: "user", userId: "U1" } },
  ]);
  assert.deepEqual(replies.map((r) => r.text), [TEXT.nonText, TEXT.welcome]);
});

test("event หนึ่งพัง ยังตอบ 200 และทำ event ถัดไปต่อ", async () => {
  const { deps, send, replies } = setup();
  let first = true;
  const orig = deps.line.reply;
  deps.line.reply = async (...a) => {
    if (first) { first = false; throw new Error("LINE down"); }
    return orig(...a);
  };
  const res = await send([textEvent("q1"), textEvent("q2", "U2", "rt-2")]);
  assert.equal(res.status, 200);
  assert.equal(replies.length, 1);
});

test("bot: ส่ง request ถูกรูปแบบ และแปลงผล JSON", async () => {
  let captured;
  const fakeClient = {
    messages: {
      parse: async (params, opts) => {
        captured = { params, opts };
        return { stop_reason: "end_turn", parsed_output: { reply: "1,990 บาท", status: "answered" }, usage: { input_tokens: 10, output_tokens: 5 } };
      },
    },
  };
  const answer = createBot({ coursesText: "คอร์ส A 1,990 บาท", client: fakeClient });
  const r = await answer([], "ราคา");
  assert.equal(r.reply, "1,990 บาท");
  assert.equal(r.status, "answered");
  assert.equal(captured.params.model, MODEL);
  assert.equal(captured.params.system[0].cache_control.type, "ephemeral");
  assert.ok(captured.params.system[0].text.includes("คอร์ส A 1,990 บาท"));
  assert.ok(captured.params.output_config.format, "ต้องมี structured output format");
  assert.equal(captured.opts.maxRetries, 0);
  assert.deepEqual(captured.params.messages.at(-1), { role: "user", content: "ราคา" });
});

test("bot: API พังหรือ parse ไม่ได้ ได้ข้อความสำรอง", async () => {
  const throwing = createBot({ coursesText: "x", client: { messages: { parse: async () => { throw new Error("timeout"); } } } });
  assert.deepEqual(await throwing([], "q"), { reply: FALLBACK_REPLY, status: "error" });

  const nullOut = createBot({ coursesText: "x", client: { messages: { parse: async () => ({ stop_reason: "end_turn", parsed_output: null }) } } });
  assert.equal((await nullOut([], "q")).status, "error");
});

const status = (st) => async () => ({ reply: "r", status: st });
const groupEvent = (type, extra = {}) => ({ type, replyToken: "g-rt", source: { type: "group", groupId: "Cgroup1", userId: "Uadmin" }, ...extra });

test("แจ้งเตือนกลุ่มแอดมินเมื่อ handoff พร้อมชื่อลูกค้า", async () => {
  const { send, pushes, kv } = setup({ answer: status("handoff") });
  await send([textEvent("โอนเงินแล้วเข้าคอร์สไม่ได้")]);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].to, "Cadmin");
  assert.match(pushes[0].text, /ลูกค้าขอคุยกับแอดมิน/);
  assert.match(pushes[0].text, /ชื่อ: สมชาย/);
  assert.match(pushes[0].text, /โอนเงินแล้วเข้าคอร์สไม่ได้/);
  assert.ok(!JSON.stringify([...kv.map.values()]).includes("สมชาย"), "ชื่อลูกค้าต้องไม่ถูกเก็บ");
});

test("แจ้งเตือนเมื่อ not_in_data แต่ไม่แจ้งเมื่อ answered หรือ error", async () => {
  for (const [st, n] of [["not_in_data", 1], ["answered", 0], ["error", 0]]) {
    const { send, pushes } = setup({ answer: status(st) });
    await send([textEvent("q")]);
    assert.equal(pushes.length, n, st);
  }
});

test("ระหว่าง handoff ข้อความถัดไปไม่แจ้งเตือนซ้ำ", async () => {
  let n = 0;
  const { send, pushes } = setup({ answer: async () => ({ reply: "r", status: n++ ? "answered" : "handoff" }) });
  await send([textEvent("ขอคุยกับคน")]);
  await send([textEvent("ฮัลโหล", "U123", "rt-2")]);
  await send([textEvent("อยู่ไหม", "U123", "rt-3")]);
  assert.equal(pushes.length, 1);
});

test("ไม่ได้ตั้ง ADMIN_GROUP_ID: ไม่ push แต่ยังตอบลูกค้า", async () => {
  const { send, pushes, replies } = setup({ answer: status("handoff"), adminGroupId: null });
  await send([textEvent("q")]);
  assert.equal(pushes.length, 0);
  assert.equal(replies.length, 1);
});

test("หาชื่อไม่ได้ หรือ push พัง ไม่กระทบลูกค้า", async () => {
  const a = setup({ answer: status("handoff"), displayName: null });
  await a.send([textEvent("q")]);
  assert.match(a.pushes[0].text, /ไม่ทราบชื่อ/);

  const b = setup({ answer: status("handoff") });
  b.deps.line.push = async () => { throw new Error("quota"); };
  const res = await b.send([textEvent("q")]);
  assert.equal(res.status, 200);
  assert.equal(b.replies.length, 1);
  assert.equal(await b.store.isHandoff([...b.kv.map.keys()].find((k) => k.startsWith("handoff/")).slice(8)), true);
});

test("กลุ่ม: ถูกเชิญแล้วบอก Group ID, ข้อความทั่วไปไม่ตอบ, /groupid ตอบ", async () => {
  const { send, replies, calls } = setup();
  await send([groupEvent("join")]);
  assert.match(replies[0].text, /Cgroup1/);

  await send([groupEvent("message", { message: { type: "text", text: "คอร์ส A ราคาเท่าไหร่" } })]);
  assert.equal(replies.length, 1, "ห้ามตอบคำถามในกลุ่ม");
  assert.equal(calls.length, 0, "ห้ามเรียก Claude จากข้อความในกลุ่ม");

  await send([groupEvent("message", { message: { type: "text", text: GROUP_ID_COMMAND } })]);
  assert.equal(replies.length, 2);
});

test("persona: ใส่ไว้ก่อนกติกา และกติกาบอกว่าชนะ persona", () => {
  const [block] = buildSystem("COURSES", "ชื่อ: น้องทดสอบ");
  const t = block.text;
  assert.ok(t.indexOf("น้องทดสอบ") < t.indexOf("กติกาของระบบ"));
  assert.ok(t.indexOf("กติกาของระบบ") < t.indexOf("COURSES"));
  assert.match(t, /สำคัญกว่า persona/);
});

test("persona: ไฟล์ว่างหรือไม่มี ใช้ค่าเริ่มต้น และยังมีกติกาครบ", () => {
  for (const p of [undefined, "", "   "]) {
    const t = buildSystem("C", p)[0].text;
    assert.match(t, /แอดมิน LINE OA/);
    assert.match(t, /not_in_data/);
  }
});

test("data/persona.md มีจริงและถูกส่งเข้า system prompt", async () => {
  const persona = parsePersona(fs.readFileSync(new URL("../data/persona.md", import.meta.url), "utf8")).prompt;
  let sent;
  const answer = createBot({ coursesText: "C", personaText: persona, client: { messages: { parse: async (p) => { sent = p; return { stop_reason: "end_turn", parsed_output: { reply: "r", status: "answered" } }; } } } });
  await answer([], "q");
  assert.ok(sent.system[0].text.includes("สมาร์ท"));
});

const personaFile = () => fs.readFileSync(new URL("../data/persona.md", import.meta.url), "utf8");

test("persona.md จริง: แยกข้อความตายตัวครบ 4 ตัว และไม่ส่งส่วนนั้นให้ AI", () => {
  const { prompt, messages } = parsePersona(personaFile());
  assert.deepEqual(Object.keys(messages).sort(), [...MESSAGE_KEYS].sort());
  assert.match(messages.welcome, /สมาร์ท/);
  assert.ok(messages.welcome.includes("\n"), "welcome หลายบรรทัดต้องคงขึ้นบรรทัดใหม่");
  assert.ok(!messages.welcome.includes("ห้ามเปลี่ยนชื่อหัวข้อย่อย"), "บรรทัดหมายเหตุ > ต้องไม่ติดมา");
  assert.ok(!prompt.includes("ข้อความตายตัว"));
  assert.ok(!prompt.includes("### welcome"));
  assert.match(prompt, /ชื่อ: สมาร์ท/);
  for (const m of Object.values(messages)) assert.match(m, /ครับ/, "persona ชายต้องลงท้ายครับ");
});

test("parsePersona: ไม่มีหัวข้อข้อความตายตัว / key แปลก / ข้อความว่าง", () => {
  assert.deepEqual(parsePersona("# P\nhello"), { prompt: "# P\nhello", messages: {} });
  const r = parsePersona("# P\n## ข้อความตายตัว\n### welcome\n\n### typo\nx\n### resumed\nกลับมาแล้ว\n## ท้าย\nend");
  assert.deepEqual(r.messages, { resumed: "กลับมาแล้ว" });
  assert.match(r.prompt, /ท้าย/);
  assert.ok(!r.prompt.includes("typo"));
});

test("handler ใช้ข้อความตายตัวจาก persona ถ้ามี ไม่มีก็ใช้ค่าเริ่มต้น", async () => {
  const a = setup();
  a.deps.messages = { welcome: "สวัสดีจากสมาร์ท", nonText: "อ่านได้แต่ตัวอักษรครับ" };
  await a.send([
    { type: "follow", replyToken: "b", source: { type: "user", userId: "U1" } },
    { type: "message", replyToken: "a", source: { type: "user", userId: "U1" }, message: { type: "image" } },
  ]);
  assert.deepEqual(a.replies.map((r) => r.text), ["สวัสดีจากสมาร์ท", "อ่านได้แต่ตัวอักษรครับ"]);

  const b = setup();
  await b.send([{ type: "follow", replyToken: "b", source: { type: "user", userId: "U1" } }]);
  assert.equal(b.replies[0].text, TEXT.welcome);
});

test("bot ใช้ fallback จาก persona เมื่อ Claude พัง", async () => {
  const bot = createBot({ coursesText: "x", fallbackReply: "สมาร์ทขัดข้องครับ", client: { messages: { parse: async () => { throw new Error("x"); } } } });
  assert.equal((await bot([], "q")).reply, "สมาร์ทขัดข้องครับ");
});
