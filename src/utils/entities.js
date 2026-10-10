// HTML entity decoding for clue text, kept free of JSX so plain Node scripts (the PDF
// export test, pipeline tools) can import it. richText.jsx re-exports it.

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', times: '×', deg: '°',
  hearts: '♥', spades: '♠', diams: '♦', clubs: '♣',
  larr: '←', uarr: '↑', rarr: '→', darr: '↓',
  bigcirc: '◯', bigtriangleup: '△', bull: '•', middot: '·',
  eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç',
  ntilde: 'ñ', uuml: 'ü', ouml: 'ö', auml: 'ä',
};

/** Turn &mdash; / &#8212; / &#x1F602; into the characters they stand for. */
export function decodeEntities(text) {
  if (!text || typeof text !== 'string' || !text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]{1,11});/g, (whole, body) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      // Astral-plane code points are the emoji ones, so String.fromCodePoint, not fromCharCode.
      if (Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff) {
        try { return String.fromCodePoint(cp); } catch { return whole; }
      }
      return whole;
    }
    const v = ENTITIES[body.toLowerCase()];
    return v === undefined ? whole : v;
  });
}
