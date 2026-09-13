import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";

import {
  attachmentsFromMarkdown,
  attachmentsFromRequest,
  classifyAttachment,
  extractDocxText,
  extractDocumentText,
  hydrateUserMessage,
} from "../src/agent/attachments.ts";
import { buildChatCompletionBody } from "../src/agent/llm.ts";
import ExcelJS from "exceljs";

function storedZip(entries: Array<{ name: string; data: string | Buffer }>): Buffer {
  return Buffer.from(zipSync(Object.fromEntries(entries.map((entry) => [entry.name, typeof entry.data === "string" ? strToU8(entry.data) : entry.data]))));
}

describe("attachments", () => {
  it("loads xlsx with patched UUID dependency including conditional formatting", async () => {
    const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet("现场");
    sheet.addRow(["漏洞数", 42]);
    sheet.addConditionalFormatting({ ref: "B1", rules: [{ type: "dataBar", priority: 1, cfvo: [{ type: "min" }, { type: "max" }], color: { argb: "FF3366FF" } }] });
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const result = await extractDocumentText(buffer, "fixture.xlsx");
    expect(result.ok && result.text).toContain("42");
  });
  it("classifies images, docs and binaries", () => {
    expect(classifyAttachment("a.png", "image/png")).toBe("image");
    expect(classifyAttachment("error.log")).toBe("text");
    expect(classifyAttachment("note.docx")).toBe("office");
    expect(classifyAttachment("scan.pdf")).toBe("pdf");
    expect(classifyAttachment("dump.bin")).toBe("binary");
  });

  it("reads stored names from upload payloads and markdown links", () => {
    const stored = "11111111-1111-1111-1111-111111111111-shot.png";
    expect(attachmentsFromRequest([{
      file_name: "shot.png",
      view_url: `/api/v1/files/${stored}`,
      mime_type: "image/png",
    }])[0]?.storedName).toBe(stored);
    expect(attachmentsFromMarkdown(`见图 ![shot.png](/api/v1/files/${stored})`)[0]?.storedName).toBe(stored);
  });

  it("extracts docx and plain text", async () => {
    const docx = storedZip([{
      name: "word/document.xml",
      data: "<w:document><w:p><w:t>登录失败</w:t></w:p></w:document>",
    }]);
    expect(extractDocxText(docx)).toContain("登录失败");
    expect((await extractDocumentText(Buffer.from("timeout at line 12"), "app.log")).ok).toBe(true);
  });

  it("hydrates images as data URLs and documents as text", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aftersale-att-"));
    await mkdir(path.join(root, "_uploads"), { recursive: true });
    const pngName = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-shot.png";
    const logName = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb-app.log";
    await writeFile(path.join(root, "_uploads", pngName), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
    await writeFile(path.join(root, "_uploads", logName), "Caused by: NullPointerException\n");
    const hydrated = await hydrateUserMessage({
      id: "u1",
      role: "user",
      content: `看这张图 ![shot.png](/api/v1/files/${pngName})`,
      source: "human",
      attachments: [{
        fileName: "app.log",
        storedName: logName,
        mimeType: "text/plain",
      }],
    }, root);
    expect(hydrated.images?.[0]?.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(hydrated.content).toContain("NullPointerException");
    expect(hydrated.content).not.toContain("/api/v1/files/");

    const body = buildChatCompletionBody({
      model: "minimax/minimax-m3:free",
      system: "sys",
      messages: [hydrated],
      tools: [],
    });
    const user = (body.messages as Array<Record<string, unknown>>)[1];
    expect(user?.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text" }),
      expect.objectContaining({ type: "image_url" }),
    ]));
  });
});
