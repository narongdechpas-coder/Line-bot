// แยก persona.md เป็นสองส่วน:
// 1) ข้อความ persona ที่ส่งให้ Claude
// 2) ข้อความตายตัวใต้หัวข้อ "## ข้อความตายตัว" ที่บอทส่งเองโดยไม่ผ่าน Claude
//    แต่ละข้อความอยู่ใต้หัวข้อย่อย "### <key>" เช่น ### welcome

export const FIXED_SECTION = "ข้อความตายตัว";
export const MESSAGE_KEYS = ["welcome", "nonText", "resumed", "fallback"];

export function parsePersona(md = "") {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${FIXED_SECTION}`);
  if (start === -1) return { prompt: md.trim(), messages: {} };

  // ส่วนข้อความตายตัวจบที่หัวข้อระดับ ## ถัดไป หรือจบไฟล์
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (end === -1) end = lines.length;

  const messages = {};
  let key = null;
  let buf = [];
  const flush = () => {
    if (key && MESSAGE_KEYS.includes(key)) {
      const text = buf.join("\n").trim();
      if (text) messages[key] = text;
    }
  };
  for (const line of lines.slice(start + 1, end)) {
    const h = line.match(/^###\s+(\S+)/);
    if (h) {
      flush();
      key = h[1];
      buf = [];
    } else if (key && !line.trim().startsWith(">")) {
      buf.push(line);
    }
  }
  flush();

  const prompt = [...lines.slice(0, start), ...lines.slice(end)].join("\n").trim();
  return { prompt, messages };
}
