// Theme markings a constructor can put on a square: a ring (circles) and a fill
// (shades). The fill used to be grey-only — the only thing imported puzzles carry — so
// `shades` stays a plain list of "r,c" keys and every older reader still draws grey.
// A colour is an optional extra, `shadeColors: { "r,c": id }`; a square in `shades`
// with no entry there is grey.
//
// The fills are light on purpose: a letter has to stay legible on top of them on screen
// and on a cheap office printer, and a greyscale print of any of them must still read as
// "this square is marked" without drowning the clue number.

export const SHADE_COLORS = [
  { id: 'gray',   label: 'Grey',   screen: '#d4d4d0', print: '#d9d9d9', grey: '#d9d9d9' },
  { id: 'yellow', label: 'Yellow', screen: '#fbe38a', print: '#fde68a', grey: '#e6e6e6' },
  { id: 'blue',   label: 'Blue',   screen: '#bcd7f7', print: '#c7ddf7', grey: '#dcdcdc' },
  { id: 'green',  label: 'Green',  screen: '#c3e6c5', print: '#cdeccf', grey: '#e0e0e0' },
  { id: 'pink',   label: 'Pink',   screen: '#f6c6d6', print: '#f8cfdc', grey: '#dedede' },
  { id: 'orange', label: 'Orange', screen: '#f9cfa4', print: '#fbd6b0', grey: '#d6d6d6' },
];

const BY_ID = new Map(SHADE_COLORS.map((c) => [c.id, c]));

/** The palette entry for an id, grey for anything unknown or missing. */
export const shadeColor = (id) => BY_ID.get(id) || BY_ID.get('gray');

/**
 * Screen fill for a shaded square. `shadeColors` may be a plain object or a Map.
 */
export const shadeFillFor = (key, shadeColors) => {
  const id = shadeColors instanceof Map ? shadeColors.get(key) : shadeColors?.[key];
  return shadeColor(id).screen;
};
