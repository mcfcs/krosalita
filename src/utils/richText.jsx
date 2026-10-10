import React from 'react';
import { decodeEntities } from './entities.js';

// Clue markup, rendered as React elements — never as raw HTML.
//
// Two vocabularies arrive here and both have to work:
//
//   1. What constructors type in this app:  **bold**  *italic*  _italic_
//   2. What the scraped corpus already contains: real HTML. 70 of 209,427 clues carry
//      tags (<em> x46, <span>, <sup>, <i>, <b>, <br />) and 25 carry entities
//      (&mdash;, &hearts;, &deg;, &#x1F602;). Those used to render literally, so
//      "<i>White Men Can't Jump</i> star Wesley" appeared on screen with its tags showing
//      and ROFL's clue was the text "&#x1F602; &#x1F602; &#x1F602;" — unsolvable as
//      displayed.
//
// Tags are parsed into elements by hand rather than passed to dangerouslySetInnerHTML:
// clue text is third-party data, and a puzzle imported from anywhere could otherwise carry
// a <script> or an onerror attribute straight into the page. Only the inline tags below
// mean anything; everything else is dropped and its text kept.

// decodeEntities lives in a JSX-free module so Node scripts (the PDF export) can share it.
export { decodeEntities };

// The inline tags worth honouring. Anything else keeps its text and loses its tag.
const TAG_ELEMENT = { i: 'em', em: 'em', b: 'strong', strong: 'strong', sup: 'sup', sub: 'sub', u: 'u' };

const MARKDOWN = /(\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_)/g;

/** The **bold** / *italic* / _italic_ pass, over a plain string. */
function renderMarkdown(text, keyBase) {
  const nodes = [];
  let last = 0;
  let key = 0;
  let m;
  MARKDOWN.lastIndex = 0;
  while ((m = MARKDOWN.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) nodes.push(<strong key={`${keyBase}b${key++}`}>{tok.slice(2, -2)}</strong>);
    else nodes.push(<em key={`${keyBase}i${key++}`}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/**
 * Render clue markup to React nodes. Safe for untrusted text.
 * Returns the original value unchanged when there is nothing to do.
 */
export function renderRich(text) {
  if (!text || typeof text !== 'string') return text;

  // No tags: the common path, markdown only.
  if (!/[<&]/.test(text)) {
    const nodes = renderMarkdown(text, 'm');
    return nodes.length ? nodes : text;
  }

  const out = [];
  const stack = [{ tag: null, children: [] }];
  const push = (node) => stack[stack.length - 1].children.push(node);
  let key = 0;
  let i = 0;
  const TAG_RE = /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(text)) !== null) {
    if (m.index > i) {
      for (const n of renderMarkdown(decodeEntities(text.slice(i, m.index)), `t${key++}`)) push(n);
    }
    i = m.index + m[0].length;
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();

    if (name === 'br') { push(<br key={`br${key++}`} />); continue; }

    const el = TAG_ELEMENT[name];
    if (!el) continue; // <span> and friends: drop the tag, keep the text

    if (!closing) {
      stack.push({ tag: el, children: [] });
    } else {
      // Close the nearest matching frame; ignore a stray closing tag.
      const idx = [...stack].reverse().findIndex((f) => f.tag === el);
      if (idx === -1) continue;
      while (stack.length > 1) {
        const frame = stack.pop();
        const Tag = frame.tag;
        stack[stack.length - 1].children.push(
          <Tag key={`e${key++}`}>{frame.children}</Tag>,
        );
        if (frame.tag === el) break;
      }
    }
  }
  if (i < text.length) {
    for (const n of renderMarkdown(decodeEntities(text.slice(i)), `t${key++}`)) push(n);
  }
  // Anything left open is closed implicitly.
  while (stack.length > 1) {
    const frame = stack.pop();
    const Tag = frame.tag;
    stack[stack.length - 1].children.push(<Tag key={`e${key++}`}>{frame.children}</Tag>);
  }
  out.push(...stack[0].children);
  return out.length ? out : text;
}

/**
 * The same content as plain text, for places that cannot render elements — a canvas, a
 * .txt answer key. Without this, a clue written as **King** is drawn into the downloadable
 * PNG with the asterisks visible, which is the one place the leak ends up in a file the
 * author hands to somebody else.
 */
export function plainRich(text) {
  if (!text || typeof text !== 'string') return text;
  return decodeEntities(text)
    .replace(/<\s*br\b[^>]*>/gi, ' ')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1');
}
