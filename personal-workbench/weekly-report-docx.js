let docx;

function getDocx() {
  if (!docx) docx = require("docx");
  return docx;
}

const TABLE_HEADINGS = [
  "课程名称",
  "学校名称",
  "任务名称",
  "任务进度",
  "任务数量",
  "任务状态",
  "本周建议情况描述"
];

function reportText(value, fallback = "") {
  return String(value ?? fallback);
}

function paragraph(value, options = {}) {
  const { Paragraph, TextRun } = getDocx();
  return new Paragraph({
    children: [new TextRun({
      text: reportText(value),
      bold: Boolean(options.bold),
      size: options.size,
      font: "Microsoft YaHei"
    })],
    heading: options.heading,
    spacing: options.spacing
  });
}

function tableCell(value, { bold = false, fill = "FFFFFF" } = {}) {
  const { TableCell, WidthType } = getDocx();
  return new TableCell({
    width: { size: 100 / TABLE_HEADINGS.length, type: WidthType.PERCENTAGE },
    shading: { fill },
    children: [paragraph(value, { bold, size: 18 })]
  });
}

function reportTable(report) {
  const { Table, TableRow, BorderStyle, WidthType } = getDocx();
  const rows = [
    new TableRow({ children: TABLE_HEADINGS.map((heading) => tableCell(heading, { bold: true, fill: "F3F6F8" })) })
  ];
  const sourceRows = Array.isArray(report?.rows) ? report.rows : [];
  if (sourceRows.length) {
    sourceRows.forEach((row) => {
      rows.push(new TableRow({
        children: [
          tableCell(row.course),
          tableCell(row.school),
          tableCell(row.taskName),
          tableCell(row.progress),
          tableCell(row.quantity),
          tableCell(row.status),
          tableCell(row.note)
        ]
      }));
    });
  } else {
    rows.push(new TableRow({
      children: ["暂无量化任务", "", "", "", "", "", ""].map((value) => tableCell(value))
    }));
  }
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows,
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: "D7DEE6" },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: "D7DEE6" },
      left: { style: BorderStyle.SINGLE, size: 4, color: "D7DEE6" },
      right: { style: BorderStyle.SINGLE, size: 4, color: "D7DEE6" },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: "D7DEE6" },
      insideVertical: { style: BorderStyle.SINGLE, size: 4, color: "D7DEE6" }
    }
  });
}

function reportList(items) {
  return (Array.isArray(items) ? items : []).map((item) => {
    const { Paragraph, TextRun } = getDocx();
    return new Paragraph({
      bullet: { level: 0 },
      children: [new TextRun({ text: reportText(item?.text), font: "Microsoft YaHei", size: 20 })]
    });
  });
}

async function buildWeeklyReportDocx(report = {}) {
  const { Document, HeadingLevel, PageOrientation, Packer } = getDocx();
  const title = reportText(report.title, "周报");
  const author = reportText(report.author, "未填写姓名");
  const dateRange = reportText(report.dateRange);
  const children = [
    paragraph(title, { heading: HeadingLevel.TITLE, bold: true, size: 32 }),
    paragraph(dateRange, { size: 18, spacing: { after: 100 } }),
    paragraph(author, { bold: true, size: 24, spacing: { after: 160 } }),
    paragraph("一、本周工作内容", { heading: HeadingLevel.HEADING_1, bold: true, size: 24 }),
    paragraph("更新至下周一前的状态，包含本周涉及的历史遗留和新增任务。", { size: 18, spacing: { after: 120 } }),
    reportTable(report),
    paragraph("其他无法量化的部分", { heading: HeadingLevel.HEADING_2, bold: true, size: 22, spacing: { before: 180 } }),
    ...reportList(report.nonQuantified),
    paragraph("二、产品需求 / Bug / 卡点 / 疑问", { heading: HeadingLevel.HEADING_1, bold: true, size: 24, spacing: { before: 180 } }),
    paragraph("记录用户反馈、交付卡点、平台问题和具有价值的后续想法。", { size: 18 }),
    ...reportList(report.issues)
  ];
  const document = new Document({
    sections: [{
      properties: {
        page: {
          size: { orientation: PageOrientation.LANDSCAPE, width: 15840, height: 12240 },
          margin: { top: 720, right: 720, bottom: 720, left: 720 }
        }
      },
      children
    }]
  });
  return Packer.toBuffer(document);
}

module.exports = { buildWeeklyReportDocx, TABLE_HEADINGS };
