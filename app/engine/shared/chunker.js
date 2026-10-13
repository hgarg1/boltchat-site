// Splits extracted text into overlapping chunks for search. Pure functions.
//   chunkParts(parts) -> [{ loc, text }]
// A chunk is about 1,800 characters (~500 tokens) with ~15% overlap. Text is split on headings and
// paragraphs first, then sentences, so a chunk rarely starts or ends mid-thought. The nearest markdown
// heading is kept in loc.heading so excerpts can say where they came from.
// Shared with the Windows app, where this file is src/ingest/chunker.js.
Boltchat.define('chunker', function (require, module, exports) {
  const CHUNK_CHARS = 1800;
  const OVERLAP_CHARS = 270;
  const MIN_CHARS = 20;

  const tokensOf = chars => Math.ceil(chars / 3.5);

  // Hard split of one block that is bigger than a chunk: sentences first, then raw slices
  function splitLong(block, size, overlap) {
    const sentences = block.split(/(?<=[.!?。！？])\s+|\n/).filter(Boolean);
    const out = [];
    let current = '';
    const push = text => { if (text.trim()) out.push(text.trim()); };
    for (const sentence of sentences) {
      if (sentence.length > size) {
        push(current);
        current = '';
        for (let i = 0; i < sentence.length; i += size - overlap) push(sentence.slice(i, i + size));
        continue;
      }
      if (current && current.length + sentence.length + 1 > size) {
        push(current);
        current = '';
      }
      current += (current ? ' ' : '') + sentence;
    }
    push(current);
    return out;
  }

  // The tail of a chunk that the next chunk starts with, cut at a word boundary
  function tailOf(text, overlap) {
    if (text.length <= overlap) return '';
    const tail = text.slice(-overlap);
    const space = tail.search(/\s/);
    return space > 0 ? tail.slice(space + 1) : tail;
  }

  function chunkPart(part, { size, overlap }) {
    const text = part.text.replace(/\r\n?/g, '\n');
    const header = part.header || '';
    const isTable = !!header;
    const joiner = isTable ? '\n' : '\n\n';
    const blocks = isTable
      ? text.split('\n').filter(l => l.trim())
      : text.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
    const chunks = [];
    let heading = part.loc?.heading || '';
    let current = ''; // the chunk being built; it starts with `carry`, the overlap from the one before
    let carry = '';
    let currentHeading = heading;

    const hasNew = () => current.length > carry.length;
    const flush = ({ keepOverlap = true } = {}) => {
      if (hasNew()) {
        // Table chunks after the first repeat the header row so every chunk is readable alone
        const body = isTable && chunks.length && !current.startsWith(header) ? `${header}\n${current}` : current;
        chunks.push({ loc: { ...part.loc, ...(currentHeading ? { heading: currentHeading } : {}) }, text: body.trim() });
        carry = keepOverlap && !isTable ? tailOf(current, overlap) : '';
      } else {
        carry = '';
      }
      current = carry;
      currentHeading = heading;
    };

    for (const block of blocks) {
      const headingMatch = !isTable && block.match(/^#{1,6}\s+(.+)/);
      if (headingMatch) {
        // A heading starts a fresh chunk (without overlap) unless what's built so far is tiny
        if (hasNew() && current.length > size / 3) flush({ keepOverlap: false });
        heading = headingMatch[1].trim().slice(0, 120);
        if (!hasNew()) currentHeading = heading; // otherwise the chunk keeps the heading it started under
      }
      const pieces = block.length > size ? splitLong(block, size, overlap) : [block];
      for (const piece of pieces) {
        if (current && current.length + joiner.length + piece.length > size) {
          if (hasNew()) flush();
          // The carried overlap plus this piece is still too big: the piece wins
          if (current && current.length + joiner.length + piece.length > size) { current = ''; carry = ''; }
        }
        current += (current ? joiner : '') + piece;
      }
    }
    flush();
    return chunks;
  }

  function chunkParts(parts, options = {}) {
    const opts = { size: options.size || CHUNK_CHARS, overlap: options.overlap ?? OVERLAP_CHARS };
    const out = [];
    for (const part of parts) {
      for (const chunk of chunkPart(part, opts)) {
        if (chunk.text.length >= MIN_CHARS || (parts.length === 1 && out.length === 0)) out.push(chunk);
      }
    }
    return out;
  }

  // Short human label for a chunk's origin: "p. 3", "slide 2", "sheet Budget", "“Introduction”"
  function locLabel(loc = {}) {
    const bits = [];
    if (loc.page) bits.push(`p. ${loc.page}`);
    if (loc.slide) bits.push(`slide ${loc.slide}`);
    if (loc.sheet) bits.push(`sheet ${loc.sheet}`);
    if (loc.chapter) bits.push(`chapter ${loc.chapter}`);
    if (loc.heading) bits.push(`“${loc.heading}”`);
    return bits.join(', ');
  }

  module.exports = { chunkParts, locLabel, tokensOf, CHUNK_CHARS, OVERLAP_CHARS };
});
