import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  createLocalPdfWorkerUrl,
  decodeTextBytes,
  extractFileText,
  scanFile,
  setLocalPdfWorkerUrl,
} from "../src/scanner/extractors.js";
import { MAX_EXTRACTED_TEXT_BYTES } from "../src/scanner/scan.js";
import type { LocalScanFile } from "../src/scanner/types.js";

function fileFromBytes(name: string, bytes: Uint8Array, type = "application/octet-stream"): LocalScanFile {
  return {
    name,
    size: bytes.byteLength,
    type,
    arrayBuffer: async () => new Uint8Array(bytes).buffer,
    text: async () => new TextDecoder().decode(bytes),
  };
}

async function createDocxFile(): Promise<LocalScanFile> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>");
  zip.file("_rels/.rels", "<?xml version=\"1.0\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>");
  zip.file("word/document.xml", "<?xml version=\"1.0\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>客户电话 13800138000</w:t></w:r></w:p></w:body></w:document>");
  return fileFromBytes(
    "sample.docx",
    await zip.generateAsync({ type: "uint8array" }),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
}

async function createXlsxFile(): Promise<LocalScanFile> {
  const zip = new JSZip();
  zip.file("xl/worksheets/sheet1.xml", "<worksheet><sheetData><row r=\"1\"><c r=\"A1\" t=\"inlineStr\"><is><t>客户电话 13800138000</t></is></c><c r=\"B1\"><f>HYPERLINK(\"mailto:demo@example.test\",\"联系邮箱\")</f><v>0</v></c></row></sheetData></worksheet>");
  zip.file("xl/comments1.xml", "<comments><commentList><comment ref=\"A1\"><text><t>批注：备用号码 13900139000</t></text></comment></commentList></comments>");
  zip.file("xl/worksheets/_rels/sheet1.xml.rels", "<Relationships><Relationship Id=\"rId1\" Target=\"https://example.test/customer/demo@example.test\"/></Relationships>");
  zip.file("xl/media/image1.png", "not-scanned-image");
  return fileFromBytes(
    "sample.xlsx",
    await zip.generateAsync({ type: "uint8array" }),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
}

function createPdf(text: string | null, pages = 1): LocalScanFile {
  const stream = text === null ? "" : `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const pageReferences = Array.from({ length: pages }, (_, index) => `${index + 3} 0 R`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageReferences}] /Count ${pages} >>`,
    ...Array.from(
      { length: pages },
      (_, index) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${pages + 3} 0 R >> >> /Contents ${pages + 4 + index} 0 R >>`,
    ),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...Array.from({ length: pages }, () => `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`),
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(output.length);
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = output.length;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return fileFromBytes("sample.pdf", new TextEncoder().encode(output), "application/pdf");
}

describe("local document extractors", () => {
  it("decodes BOM-marked UTF-16 text before detection", async () => {
    const source = "手机号：13800138000";
    const encoded = new Uint8Array(2 + [...source].reduce((total, character) => total + character.length * 2, 0));
    encoded.set([0xff, 0xfe]);
    let offset = 2;
    for (const character of source) {
      for (let index = 0; index < character.length; index += 1) {
        const code = character.charCodeAt(index);
        encoded[offset] = code & 0xff;
        encoded[offset + 1] = code >>> 8;
        offset += 2;
      }
    }
    expect(decodeTextBytes(encoded.buffer)).toBe(source);
    const result = await extractFileText(fileFromBytes("utf16.txt", encoded, "text/plain"));
    expect(result.text).toBe(source);
  });

  it("fails closed for a binary payload disguised as text", async () => {
    const bytes = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x00, 0x01]);
    await expect(extractFileText(fileFromBytes("payload.txt", bytes, "text/plain"))).resolves.toMatchObject({
      format: "text",
      coverage: "none",
      summary: { reason: "parse_failed" },
    });
  });

  it("accepts only an extension-local PDF worker URL", () => {
    expect(createLocalPdfWorkerUrl((path) => `chrome-extension://test/${path}`)).toBe(
      "chrome-extension://test/vendor/pdfjs/pdf.worker.mjs",
    );
    expect(() => setLocalPdfWorkerUrl("https://example.test/pdf.worker.mjs")).toThrow("chrome-extension URL");
    expect(() => setLocalPdfWorkerUrl("chrome-extension://trusted@evil/pdf.worker.mjs")).toThrow("chrome-extension URL");
  });

  it("extracts raw text from a DOCX document", async () => {
    const result = await extractFileText(await createDocxFile());

    expect(result).toMatchObject({
      format: "docx",
      coverage: "complete",
      text: expect.stringContaining("客户电话 13800138000"),
    });
  });

  it("decodes numeric XML entities before scanning Office text", async () => {
    const zip = new JSZip();
    zip.file("word/document.xml", "<document>手机号 &#49;&#51;&#56;&#48;&#48;&#49;&#51;&#56;&#48;&#48;&#48;</document>");
    const result = await extractFileText(fileFromBytes("entities.docx", await zip.generateAsync({ type: "uint8array" })));
    expect(result.text).toContain("手机号 13800138000");
  });

  it("rejects an Office XML payload beyond the extraction budget before showing a derivative", async () => {
    const zip = new JSZip();
    zip.file("word/document.xml", `<document>${"x".repeat(MAX_EXTRACTED_TEXT_BYTES + 1)}</document>`);
    const file = fileFromBytes("large.docx", await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }));

    await expect(extractFileText(file)).resolves.toEqual({
      format: "docx",
      coverage: "none",
      text: "",
      summary: { reason: "text_limit" },
    });
  });

  it("fails closed on an Office archive with an unsafe path", async () => {
    const zip = new JSZip();
    zip.file("word/../outside.xml", "手机号 13800138000");
    const file = fileFromBytes("unsafe.docx", await zip.generateAsync({ type: "uint8array" }));

    await expect(extractFileText(file)).resolves.toMatchObject({
      format: "docx",
      coverage: "none",
      summary: { reason: "parse_failed" },
    });
  });

  it("rejects a highly compressed Office media entry before inflation", async () => {
    const zip = new JSZip();
    zip.file("xl/worksheets/sheet1.xml", "<worksheet/>");
    zip.file("xl/media/image1.bin", "x".repeat(1024 * 1024), { compression: "DEFLATE" });
    const file = fileFromBytes("bomb.xlsx", await zip.generateAsync({ type: "uint8array" }));

    await expect(extractFileText(file)).resolves.toMatchObject({
      format: "xlsx",
      coverage: "none",
      summary: { reason: "text_limit" },
    });
  });

  it("extracts XLSX cell, formula, comment and hyperlink relationship text and marks media as partial", async () => {
    const result = await extractFileText(await createXlsxFile());

    expect(result).toMatchObject({ format: "xlsx", coverage: "partial", summary: { reason: "embedded_media" } });
    expect(result.text).toContain("客户电话 13800138000");
    expect(result.text).toContain("HYPERLINK");
    expect(result.text).toContain("备用号码 13900139000");
    expect(result.text).toContain("demo@example.test");
  });

  it("treats a text-native PDF as text-layer-only coverage while detecting sensitive contents", async () => {
    const result = await scanFile(createPdf("phone 13800138000"));

    expect(result).toMatchObject({
      format: "pdf",
      coverage: "partial",
      status: "partial",
      findings: [{ kind: "phone", count: 1 }],
      summary: { reason: "pdf_text_layer_only", pagesWithText: 1, pagesWithoutText: 0 },
    });
  });

  it("preserves review-required coverage when the extracted document text is otherwise complete", async () => {
    const result = await scanFile(await createDocxFile(), {
      detectionProfile: "balanced",
      semanticReviewProvider: {
        review: () => [{ kind: "person_name", start: 0, end: 2, score: 0.9, requiresConfirmation: true }],
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      coverage: "partial",
      summary: { reason: "review_required" },
      requiresReview: true,
    });
  });

  it("marks a PDF without a text layer as partial", async () => {
    const result = await extractFileText(createPdf(null));

    expect(result).toEqual({
      format: "pdf",
      coverage: "partial",
      text: "",
      summary: { reason: "pdf_without_text", pagesWithText: 0, pagesWithoutText: 1 },
    });
  });

  it("keeps PDF work bounded at the page cap and reports incomplete coverage", async () => {
    const result = await extractFileText(createPdf("phone 13800138000", 21));

    expect(result.summary.pagesWithText).toBe(20);
    expect(result.coverage).toBe("partial");
    expect(result.summary.reason).toBe("page_limit");
    expect(result.summary.pagesWithoutText).toBe(1);
  });

  it("rejects an oversized compressed XML part before inflating it", async () => {
    const zip = new JSZip();
    // STORE 让压缩数据量等于内容长度，直接触碰压缩数据闸门。
    // 该闸门存在的意义是：声明的未压缩大小可以谎报，压缩数据量不能。
    zip.file("word/document.xml", "x".repeat(600 * 1024), { compression: "STORE" });
    const file = fileFromBytes("inflate.docx", await zip.generateAsync({ type: "uint8array" }));

    await expect(extractFileText(file)).resolves.toMatchObject({
      format: "docx",
      coverage: "none",
      summary: { reason: "text_limit" },
    });
  });

  it("extracts docProps metadata so authorship PII is scanned", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("_rels/.rels", "<Relationships/>");
    zip.file("word/document.xml", "<document>无害正文</document>");
    zip.file(
      "docProps/core.xml",
      "<cp:coreProperties xmlns:cp=\"c\" xmlns:dc=\"d\"><dc:creator>甲方对接人</dc:creator><cp:lastModifiedBy>13800138000</cp:lastModifiedBy></cp:coreProperties>",
    );
    const file = fileFromBytes("meta.docx", await zip.generateAsync({ type: "uint8array" }));

    const extracted = await extractFileText(file);
    expect(extracted.coverage).toBe("complete");
    expect(extracted.text).toContain("13800138000");

    const scanned = await scanFile(file);
    expect(scanned.findings).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "phone" })]));
  });

  it("marks an embedded OLE object as uncovered even without a media folder", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("_rels/.rels", "<Relationships/>");
    zip.file("word/document.xml", "<document>客户电话 13800138000</document>");
    zip.file("word/embeddings/oleObject1.bin", "embedded-workbook-bytes");
    const file = fileFromBytes("ole.docx", await zip.generateAsync({ type: "uint8array" }));

    await expect(extractFileText(file)).resolves.toMatchObject({
      format: "docx",
      coverage: "partial",
      summary: { reason: "embedded_media" },
    });
  });

  it("keeps the uncovered-parts reason alongside review-required", async () => {
    const zip = new JSZip();
    zip.file("word/document.xml", "<document>客户电话 13800138000</document>");
    zip.file("docProps/thumbnail.jpeg", "thumbnail-bytes");
    const file = fileFromBytes("thumb.docx", await zip.generateAsync({ type: "uint8array" }));

    const result = await scanFile(file, {
      detectionProfile: "balanced",
      semanticReviewProvider: {
        review: () => [{ kind: "person_name", start: 0, end: 2, score: 0.9, requiresConfirmation: true }],
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      coverage: "partial",
      requiresReview: true,
      summary: { reason: "review_required", secondaryReason: "embedded_media" },
    });
  });
});
