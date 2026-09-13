// Keep the selected square above the on-screen keyboard.
//
// The dock is `position: fixed` at the bottom of the viewport, so on a phone it covers the
// lower third of the grid — measured 125px of a 390x844 screen, about 6 of 15 rows. Worse
// than hidden: a tap on a covered square lands on the dock instead, so the selection simply
// does not move and the grid looks dead. Nothing scrolled the grid; the only scroll logic
// in the editors moves the CLUE list.
//
// This nudges the scroll just enough to clear the square, and only when it is actually
// covered — scrolling on every selection change would fight the user for control of the
// viewport.

const MARGIN = 10;

/** The scrollable ancestor that actually moves, which is rarely the window here: the app
 *  root sets `overflow-x: hidden`, and per spec that computes `overflow-y` to `auto`. */
function scrollerFor(el) {
  let n = el.parentElement;
  while (n && n !== document.body) {
    const st = getComputedStyle(n);
    if (n.scrollHeight > n.clientHeight + 4 && /auto|scroll|hidden/.test(st.overflowY + st.overflowX)) return n;
    n = n.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}

export function keepClearOfDock(el) {
  if (!el || typeof window === 'undefined') return;

  const dock = document.querySelector('.solve-dock');
  const dockVisible = dock && getComputedStyle(dock).display !== 'none';
  const floor = dockVisible ? dock.getBoundingClientRect().top : window.innerHeight;

  const r = el.getBoundingClientRect();
  const covered = r.bottom + MARGIN > floor;
  const above = r.top - MARGIN < 0;
  if (!covered && !above) return;

  const scroller = scrollerFor(el);
  const isRoot = scroller === (document.scrollingElement || document.documentElement);
  const viewTop = isRoot ? 0 : scroller.getBoundingClientRect().top;
  const viewBottom = isRoot ? floor : Math.min(floor, scroller.getBoundingClientRect().bottom);

  let delta = 0;
  if (r.bottom + MARGIN > viewBottom) delta = r.bottom + MARGIN - viewBottom;
  else if (r.top - MARGIN < viewTop) delta = r.top - MARGIN - viewTop;
  if (!delta) return;

  // index.css sets `html { scroll-behavior: smooth }`, so this animates on the window; an
  // element scroller needs the option spelled out to match.
  if (scroller.scrollBy) scroller.scrollBy({ top: delta, behavior: 'smooth' });
  else scroller.scrollTop += delta;
}
