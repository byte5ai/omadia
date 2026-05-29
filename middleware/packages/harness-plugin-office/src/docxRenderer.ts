import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import {
  MEDIA_TYPE,
  type DocxBlock,
  type DocxDescriptor,
  type RenderResult,
} from './types.js';
import { sanitizeFilename } from './filename.js';

const HEADING_BY_LEVEL: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
};

function blockToChildren(block: DocxBlock): Array<Paragraph | Table> {
  switch (block.type) {
    case 'heading':
      return [
        new Paragraph({
          heading: HEADING_BY_LEVEL[block.level] ?? HeadingLevel.HEADING_2,
          children: [new TextRun({ text: block.text })],
        }),
      ];
    case 'paragraph':
      return [new Paragraph({ children: [new TextRun({ text: block.text })] })];
    case 'bullets':
      return block.items.map(
        (item) =>
          new Paragraph({
            bullet: { level: 0 },
            children: [new TextRun({ text: item })],
          }),
      );
    case 'table': {
      const headerRow = new TableRow({
        tableHeader: true,
        children: block.headers.map(
          (h) =>
            new TableCell({
              children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })] })],
            }),
        ),
      });
      const dataRows = block.rows.map(
        (row) =>
          new TableRow({
            children: block.headers.map(
              (_h, colIndex) =>
                new TableCell({
                  children: [new Paragraph({ children: [new TextRun({ text: row[colIndex] ?? '' })] })],
                }),
            ),
          }),
      );
      return [
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [headerRow, ...dataRows],
        }),
      ];
    }
  }
}

/**
 * Render a {@link DocxDescriptor} to .docx bytes. Content is laid out exactly
 * as the descriptor declares — the renderer adds no data of its own. Byte-
 * identical reproduction is out of scope (the OOXML zip embeds its own entry
 * order); "deterministic" here means same descriptor → same logical document.
 */
export async function renderDocx(descriptor: DocxDescriptor): Promise<RenderResult> {
  const children: Array<Paragraph | Table> = [];
  if (descriptor.title) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.TITLE,
        children: [new TextRun({ text: descriptor.title })],
      }),
    );
  }
  for (const block of descriptor.blocks) {
    children.push(...blockToChildren(block));
  }

  const doc = new Document({
    creator: 'Omadia',
    ...(descriptor.title ? { title: descriptor.title } : {}),
    sections: [{ children }],
  });

  const buffer = await Packer.toBuffer(doc);

  return {
    buffer: Buffer.from(buffer as unknown as Uint8Array),
    mediaType: MEDIA_TYPE.docx,
    ext: 'docx',
    filename: sanitizeFilename(descriptor.filename, 'docx', 'document'),
    // docx is not row/dataset-bound — the rowsWritten postcondition is an
    // xlsx-only concern, so report 0 and let the tool skip the check.
    rowsWritten: 0,
  };
}
