const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const { buildWeeklyReportDocx } = require("../weekly-report-docx");

function localZipEntries(buffer) {
  const entries = new Map();
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const compressionMethod = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString("utf8");
    const dataStart = nameStart + nameLength + extraLength;
    const compressedData = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = compressionMethod === 8 ? zlib.inflateRawSync(compressedData) : compressedData;
    entries.set(name, data);
    offset = dataStart + compressedSize;
  }
  return entries;
}

test("weekly report DOCX export creates an OOXML package with a table document", async () => {
  const buffer = await buildWeeklyReportDocx({
    title: "M7W2周报",
    author: "刘毅",
    dateRange: "7月13日 - 7月19日",
    rows: [{
      course: "数据结构与算法",
      school: "河北师范大学",
      taskName: "能力训练搭建",
      progress: "100%",
      quantity: "2",
      status: "已完成",
      note: "已验收"
    }],
    nonQuantified: [{ text: "完成模板核对" }],
    issues: [{ text: "暂无" }]
  });

  assert.ok(buffer.length > 1000);
  assert.equal(buffer.subarray(0, 4).toString("hex"), "504b0304");
  const entries = localZipEntries(buffer);
  assert.ok(entries.has("[Content_Types].xml"));
  assert.ok(entries.has("word/document.xml"));
  assert.ok(entries.has("word/styles.xml"));
  const documentXml = entries.get("word/document.xml").toString("utf8");
  assert.match(documentXml, /<w:tbl>/);
  assert.match(documentXml, /M7W2周报/);
  assert.match(documentXml, /河北师范大学/);
});
