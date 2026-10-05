/** PDF text objects only: arbitrary text never becomes markup, a URL, or an action. */
function pdfText(text: string): string {
  return `<${Buffer.from(text, 'ascii').toString('hex')}>`;
}

async function* wrapped(lines: AsyncIterable<string> | Iterable<string>): AsyncGenerator<string> {
  for await (const line of lines) {
    for (const paragraph of line.split(/\r\n|\r|\n/)) {
      // Wrap the visible escape notation too; Unicode must not overflow the page width.
      let buffer = '';
      for (const char of paragraph) {
        const code = char.codePointAt(0) ?? 0;
        const visible = code >= 32 && code <= 126 ? char : `\\u{${code.toString(16)}}`;
        if (buffer.length + visible.length > 72) {
          yield buffer;
          buffer = '';
        }
        buffer += visible;
      }
      yield buffer;
    }
  }
}

/** One page of text is buffered. Cross-reference offsets retain no report contents. */
export async function* streamPdf(
  lines: AsyncIterable<string> | Iterable<string>,
): AsyncGenerator<Uint8Array> {
  let offset = 0;
  const offsets: number[] = [0];
  const pages: number[] = [];
  const bytes = (text: string) => {
    const out = Buffer.from(text, 'ascii');
    offset += out.length;
    return out;
  };
  const object = (id: number, body: string) => {
    offsets[id] = offset;
    return bytes(`${id} 0 obj\n${body}\nendobj\n`);
  };
  yield bytes('%PDF-1.4\n');
  yield object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  yield object(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');
  const source = wrapped(lines);
  let ended = false;
  try {
    while (!ended) {
      const page: string[] = [];
      while (page.length < 48) {
        const next = await source.next();
        if (next.done) {
          ended = true;
          break;
        }
        page.push(next.value);
      }
      if (page.length === 0 && pages.length > 0) break;
      const pageId = 4 + pages.length * 2;
      const contentId = pageId + 1;
      pages.push(pageId);
      const content = `BT\n/F1 9 Tf\n12 TL\n40 790 Td\n${page.map((line) => `${pdfText(line)} Tj T*`).join('\n')}\nET\n`;
      yield object(
        pageId,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
      );
      yield object(
        contentId,
        `<< /Length ${Buffer.byteLength(content, 'ascii')} >>\nstream\n${content}endstream`,
      );
    }
  } finally {
    // Aborting a download closes the upstream cursor without reading the remaining rows.
    await source.return(undefined);
  }
  yield object(
    2,
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((id) => `${id} 0 R`).join(' ')}] >>`,
  );
  const xrefAt = offset;
  yield bytes(
    `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((at) => `${String(at).padStart(10, '0')} 00000 n \n`)
      .join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`,
  );
}
