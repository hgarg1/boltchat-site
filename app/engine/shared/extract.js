// Turns an uploaded file into plain text parts that can be chunked and searched.
// Runs in the indexing worker (engine/ingest-worker.js), never on the page's thread.
//   extractFile(buffer, name) -> { parts: [{ loc, text, header? }], kind }
// loc says where the text came from ({ page }, { slide }, { sheet }, { chapter }), so answers can cite it.
// Shared with the Windows app, where this file is src/ingest/extract.js.
Boltchat.define('extract', function (require, module, exports) {
  const path = require('node:path');

  class IngestError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code; // unsupported | empty | no-text | corrupt | too-large
    }
  }

  const TEXT_EXT = new Set([
    'txt', 'text', 'md', 'markdown', 'mdx', 'rst', 'org', 'tex', 'log', 'csv', 'tsv', 'json', 'jsonl', 'ndjson',
    'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties', 'srt', 'vtt', 'ass', 'sub',
    'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'pyi', 'ipynb', 'java', 'kt', 'kts', 'scala', 'groovy', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs',
    'go', 'rs', 'rb', 'php', 'swift', 'm', 'mm', 'dart', 'lua', 'r', 'jl', 'pl', 'sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1',
    'sql', 'graphql', 'proto', 'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'gradle', 'cmake', 'make', 'mk', 'dockerfile', 'gitignore'
  ]);
  const HTML_EXT = new Set(['html', 'htm', 'xhtml', 'svg']);
  const BLOCKED = {
    image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'avif', 'ico'],
    audio: ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac', 'opus'],
    video: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'wmv'],
    archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'],
    program: ['exe', 'dll', 'msi', 'bin', 'dmg', 'iso', 'apk', 'so']
  };
  const MAX_TEXT_CHARS = 8_000_000; // ~2M tokens: far past anything useful, and it bounds memory
  const MAX_PDF_PAGES = 3000;
  const MAX_SHEET_ROWS = 50_000;

  const extOf = name => path.extname(String(name || '')).slice(1).toLowerCase() || path.basename(String(name || '')).toLowerCase();

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
  }

  // UTF-8 (with or without BOM), UTF-16 with a BOM, else Windows-1252
  function decodeText(buf) {
    if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
    if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf).replace(/^\uFEFF/, '');
    } catch {
      return new TextDecoder('windows-1252').decode(buf);
    }
  }

  const looksBinary = buf => {
    const n = Math.min(buf.length, 8192);
    let odd = 0;
    for (let i = 0; i < n; i++) {
      const b = buf[i];
      if (b === 0) return true;
      if (b < 9 || (b > 13 && b < 32)) odd++;
    }
    return n > 0 && odd / n > 0.1;
  };

  function htmlToText(html) {
    return decodeEntities(
      html
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<(script|style|head|noscript)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n, inner) => `\n\n${'#'.repeat(Number(n))} ${inner.replace(/<[^>]+>/g, '')}\n\n`)
        .replace(/<(br|hr)\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|section|article|li|tr|table|ul|ol|blockquote|pre|figure)>/gi, '\n\n')
        .replace(/<\/t[dh]>/gi, ' | ')
        .replace(/<[^>]+>/g, '')
    ).replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function rtfToText(rtf) {
    const cp1252 = code => new TextDecoder('windows-1252').decode(Uint8Array.of(code));
    let out = rtf
      .replace(/\{\\\*[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, '') // destinations like {\*\generator …}
      .replace(/\{\\(fonttbl|colortbl|stylesheet|info|pict)[\s\S]*?\}\s*\}/g, '')
      .replace(/\\'([0-9a-f]{2})/gi, (_m, h) => cp1252(parseInt(h, 16)))
      .replace(/\\u(-?\d+)\??/g, (_m, n) => String.fromCodePoint((Number(n) + 65536) % 65536))
      .replace(/\\(par|line|sect|page)\b ?/g, '\n')
      .replace(/\\tab\b ?/g, '\t')
      .replace(/\\[a-z]+-?\d* ?/gi, '')
      .replace(/\\([\\{}])/g, '$1')
      .replace(/[{}]/g, '');
    return out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  // ---------- Office / ebook containers (zip + XML) ----------

  let JSZipClass;
  async function openZip(buf) {
    JSZipClass ||= require('jszip');
    try {
      return await JSZipClass.loadAsync(buf);
    } catch {
      throw new IngestError('corrupt', 'This file looks damaged or is not the format its name says.');
    }
  }

  const zipText = async (zip, file) => {
    const entry = zip.file(file);
    return entry ? decodeText(await entry.async('uint8array')) : null;
  };
  const sortNumeric = names => names.sort((a, b) => (Number(a.match(/(\d+)\.xml$/)?.[1]) || 0) - (Number(b.match(/(\d+)\.xml$/)?.[1]) || 0));

  // Walks an XML string for text runs, paragraph ends, tabs and breaks, and builds lines. Each key of
  // `tokens` is a regex source; table cells keep their paragraphs on one line, joined by " | ".
  function xmlParagraphs(xml, tokens) {
    const names = ['t', 'pEnd', 'br', 'tab', 'cellStart', 'cellEnd', 'rowEnd', 'heading'].filter(n => tokens[n]);
    const re = new RegExp(names.map(n => `(?<${n}>${tokens[n]})`).join('|'), 'g');
    const lines = [];
    let line = '';
    let heading = 0;
    let inCell = false;
    const flush = () => {
      const text = line.replace(/[ \t|]+$/g, '');
      if (text.trim()) lines.push(heading ? `${'#'.repeat(heading)} ${text.trim()}` : text);
      else if (lines.length && lines.at(-1) !== '') lines.push('');
      line = '';
      heading = 0;
    };
    for (const m of xml.matchAll(re)) {
      const g = m.groups;
      if (g.heading) heading = Math.min(6, Number(g.heading.match(/(\d)/)?.[1]) || 1);
      else if (g.t) line += decodeEntities(g.t.replace(/<[^>]+>/g, ''));
      else if (g.tab) line += '\t';
      else if (g.br) line += '\n';
      else if (g.cellStart) inCell = true;
      else if (g.cellEnd) { inCell = false; line = line.replace(/ +$/, '') + ' | '; }
      else if (g.rowEnd) flush();
      else if (g.pEnd) { if (inCell) line += line && !/[ |]$/.test(line) ? ' ' : ''; else flush(); }
    }
    flush();
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  const WORD = { t: '<w:t(?:\\s[^>]*)?>[^<]*</w:t>', pEnd: '</w:p>', br: '<w:br\\s*/>', tab: '<w:tab\\s*/>', cellStart: '<w:tc[\\s>]', cellEnd: '</w:tc>', rowEnd: '</w:tr>', heading: '<w:pStyle w:val="Heading\\d"\\s*/>' };
  const SLIDE = { t: '<a:t(?:\\s[^>]*)?>[^<]*</a:t>', pEnd: '</a:p>', br: '<a:br\\s*/>' };

  async function fromDocx(buf) {
    const zip = await openZip(buf);
    const xml = await zipText(zip, 'word/document.xml');
    if (!xml) throw new IngestError('corrupt', 'No document body found in this Word file.');
    const text = xmlParagraphs(xml, WORD);
    return [{ loc: {}, text }];
  }

  async function fromPptx(buf) {
    const zip = await openZip(buf);
    const slides = sortNumeric(Object.keys(zip.files).filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f)));
    if (!slides.length) throw new IngestError('corrupt', 'No slides found in this presentation.');
    const parts = [];
    for (const file of slides) {
      const n = Number(file.match(/slide(\d+)\.xml$/)[1]);
      let text = xmlParagraphs(await zipText(zip, file), SLIDE);
      const notes = await zipText(zip, `ppt/notesSlides/notesSlide${n}.xml`);
      const noteText = notes ? xmlParagraphs(notes, SLIDE) : '';
      if (noteText) text += `\n\nSpeaker notes: ${noteText}`;
      if (text.trim()) parts.push({ loc: { slide: n }, text });
    }
    return parts;
  }

  const colIndex = ref => {
    let n = 0;
    for (const ch of ref.replace(/[^A-Z]/gi, '').toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
    return n - 1;
  };

  async function fromXlsx(buf) {
    const zip = await openZip(buf);
    const shared = [];
    const sst = await zipText(zip, 'xl/sharedStrings.xml');
    if (sst) {
      for (const si of sst.matchAll(/<si[\s>][\s\S]*?<\/si>/g)) {
        shared.push(decodeEntities([...si[0].matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map(m => m[1]).join('')));
      }
    }
    const workbook = await zipText(zip, 'xl/workbook.xml');
    const rels = (await zipText(zip, 'xl/_rels/workbook.xml.rels')) || '';
    if (!workbook) throw new IngestError('corrupt', 'No workbook found in this spreadsheet.');
    const target = id => {
      const m = rels.match(new RegExp(`<Relationship\\b[^>]*\\bId="${id}"[^>]*>`))?.[0];
      const t = m?.match(/Target="([^"]+)"/)?.[1];
      return t ? (t.startsWith('/') ? t.slice(1) : `xl/${t}`) : null;
    };
    const parts = [];
    for (const sheet of workbook.matchAll(/<sheet\b[^>]*>/g)) {
      const name = decodeEntities(sheet[0].match(/\bname="([^"]*)"/)?.[1] || 'Sheet');
      const rid = sheet[0].match(/\br:id="([^"]+)"/)?.[1];
      const file = rid && target(rid);
      const xml = file && (await zipText(zip, file));
      if (!xml) continue;
      const rows = [];
      for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
        if (rows.length >= MAX_SHEET_ROWS) break;
        const cells = [];
        for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const attrs = c[1];
          const body = c[2] || '';
          const ref = attrs.match(/\br="([A-Z]+\d+)"/)?.[1];
          const type = attrs.match(/\bt="(\w+)"/)?.[1];
          let value = '';
          if (type === 'inlineStr') value = decodeEntities([...body.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map(m => m[1]).join(''));
          else {
            const v = body.match(/<v>([^<]*)<\/v>/)?.[1] ?? '';
            value = type === 's' ? shared[Number(v)] ?? '' : type === 'b' ? (v === '1' ? 'TRUE' : 'FALSE') : decodeEntities(v);
          }
          if (value !== '') cells[ref ? colIndex(ref) : cells.length] = value;
        }
        if (cells.length) rows.push([...cells].map(v => v ?? '').join(' | '));
      }
      if (rows.length) parts.push({ loc: { sheet: name }, text: rows.join('\n') });
    }
    return parts;
  }

  async function fromOdt(buf) {
    const zip = await openZip(buf);
    const xml = await zipText(zip, 'content.xml');
    if (!xml) throw new IngestError('corrupt', 'No content found in this document.');
    const paragraphs = [...xml.matchAll(/<text:([ph])\b[^>]*>([\s\S]*?)<\/text:\1>/g)].map(m => {
      const inner = decodeEntities(m[2].replace(/<text:line-break\s*\/>/g, '\n').replace(/<text:tab\s*\/>/g, '\t').replace(/<text:s\b[^>]*\/>/g, ' ').replace(/<[^>]+>/g, ''));
      return m[1] === 'h' ? `## ${inner}` : inner;
    });
    return [{ loc: {}, text: paragraphs.filter(p => p.trim()).join('\n\n') }];
  }

  async function fromEpub(buf) {
    const zip = await openZip(buf);
    const container = await zipText(zip, 'META-INF/container.xml');
    const opfPath = container?.match(/full-path="([^"]+)"/)?.[1];
    const opf = opfPath && (await zipText(zip, opfPath));
    if (!opf) throw new IngestError('corrupt', 'This ebook has no readable table of contents.');
    const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
    const manifest = new Map([...opf.matchAll(/<item\b[^>]*>/g)].map(m => [m[0].match(/\bid="([^"]+)"/)?.[1], m[0].match(/\bhref="([^"]+)"/)?.[1]]));
    const parts = [];
    let chapter = 0;
    for (const ref of opf.matchAll(/<itemref\b[^>]*\bidref="([^"]+)"/g)) {
      const href = manifest.get(ref[1]);
      if (!href) continue;
      const html = await zipText(zip, base + decodeURIComponent(href.split('#')[0]));
      if (!html) continue;
      const text = htmlToText(html);
      chapter++;
      if (text) parts.push({ loc: { chapter }, text });
    }
    return parts;
  }

  // ---------- PDF ----------

  let pdfjsPromise;
  async function fromPdf(buf) {
    pdfjsPromise ||= (async () => {
      const pdfjs = await import(`${self.BOLTCHAT_VENDOR}pdfjs/pdf.min.mjs`);
      // pdf.js wants a worker of its own. Handing it the worker module up front makes it parse right here
      // instead (this already runs in a worker, off the page's thread).
      globalThis.pdfjsWorker ||= await import(`${self.BOLTCHAT_VENDOR}pdfjs/pdf.worker.min.mjs`);
      if (!pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = `${self.BOLTCHAT_VENDOR}pdfjs/pdf.worker.min.mjs`;
      return pdfjs;
    })();
    const pdfjs = await pdfjsPromise;
    let doc;
    let task;
    try {
      task = pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 });
      doc = await task.promise;
    } catch (err) {
      await task?.destroy().catch(() => {});
      if (err?.name === 'PasswordException') throw new IngestError('unsupported', 'This PDF is password-protected.');
      throw new IngestError('corrupt', `This PDF could not be read (${String(err?.message || err).slice(0, 100)}).`);
    }
    const parts = [];
    try {
      const pages = Math.min(doc.numPages, MAX_PDF_PAGES);
      for (let n = 1; n <= pages; n++) {
        const page = await doc.getPage(n);
        const content = await page.getTextContent();
        let text = '';
        for (const item of content.items) text += item.str + (item.hasEOL ? '\n' : item.str && !/\s$/.test(item.str) ? ' ' : '');
        text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        if (text) parts.push({ loc: { page: n }, text });
        page.cleanup();
      }
    } finally {
      await task.destroy().catch(() => {});
    }
    return parts;
  }

  // ---------- Plain text ----------

  function fromText(buf, ext) {
    const text = decodeText(buf);
    if (ext === 'csv' || ext === 'tsv') {
      const lines = text.split(/\r?\n/).filter(l => l.trim());
      if (!lines.length) return [];
      return [{ loc: {}, text: lines.join('\n'), header: lines[0] }];
    }
    if (ext === 'ipynb') {
      try {
        const nb = JSON.parse(text);
        const cells = (nb.cells || []).map(c => `${c.cell_type === 'code' ? '```python\n' : ''}${[].concat(c.source || []).join('')}${c.cell_type === 'code' ? '\n```' : ''}`);
        return [{ loc: {}, text: cells.join('\n\n') }];
      } catch { /* plain JSON text below */ }
    }
    if (HTML_EXT.has(ext)) return [{ loc: {}, text: htmlToText(text) }];
    if (ext === 'rtf') return [{ loc: {}, text: rtfToText(text) }];
    return [{ loc: {}, text: text.replace(/\r\n?/g, '\n') }];
  }

  async function extractFile(buffer, name) {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const ext = extOf(name);
    for (const [kind, list] of Object.entries(BLOCKED)) {
      if (list.includes(ext)) {
        throw new IngestError('unsupported', kind === 'image'
          ? 'Images can’t be searched yet. Attach them to a message instead.'
          : `${kind[0].toUpperCase()}${kind.slice(1)} files can’t be used as project files.`);
      }
    }
    if (!buf.length) throw new IngestError('empty', 'This file is empty.');

    let parts;
    let kind;
    const head = buf.subarray(0, 5).toString('latin1');
    if (ext === 'pdf' || head === '%PDF-') { kind = 'pdf'; parts = await fromPdf(buf); }
    else if (ext === 'docx' || ext === 'docm') { kind = 'docx'; parts = await fromDocx(buf); }
    else if (ext === 'pptx' || ext === 'pptm') { kind = 'pptx'; parts = await fromPptx(buf); }
    else if (ext === 'xlsx' || ext === 'xlsm') { kind = 'xlsx'; parts = await fromXlsx(buf); }
    else if (ext === 'odt' || ext === 'odp') { kind = 'odt'; parts = await fromOdt(buf); }
    else if (ext === 'epub') { kind = 'epub'; parts = await fromEpub(buf); }
    else if (ext === 'doc' || ext === 'xls' || ext === 'ppt') throw new IngestError('unsupported', `Old .${ext} files aren’t supported. Save it as .${ext}x (or PDF) first.`);
    else if (TEXT_EXT.has(ext) || HTML_EXT.has(ext) || ext === 'rtf') { kind = 'text'; parts = fromText(buf, ext); }
    else if (!looksBinary(buf)) { kind = 'text'; parts = fromText(buf, ext); }
    else throw new IngestError('unsupported', `.${ext || 'this'} files aren’t supported.`);

    parts = parts.map(p => ({ ...p, text: p.text.replace(/\u0000/g, '') })).filter(p => p.text.trim());
    let total = 0;
    for (const p of parts) {
      if (total + p.text.length > MAX_TEXT_CHARS) p.text = p.text.slice(0, Math.max(0, MAX_TEXT_CHARS - total));
      total += p.text.length;
    }
    parts = parts.filter(p => p.text.trim());
    if (!parts.length) {
      throw new IngestError('no-text', kind === 'pdf'
        ? 'No text found. This PDF is probably a scan; text recognition (OCR) isn’t available yet.'
        : 'No text found in this file.');
    }
    return { parts, kind };
  }

  module.exports = { extractFile, IngestError, htmlToText, decodeEntities, MAX_TEXT_CHARS };
});
