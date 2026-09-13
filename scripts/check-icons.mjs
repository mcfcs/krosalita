// Every icon used in JSX must actually be imported, and every imported name must actually
// be exported by Icons.jsx.
//
// This exists because a missing icon import is invisible until runtime and then takes the
// WHOLE APP down to a white screen: `<Trophy />` with no import is a ReferenceError thrown
// during render, React unmounts the tree, and you get zero buttons and no text. Vite builds
// it happily — there is no bundler error to catch, because JSX compiles to a call on an
// identifier that simply is not there. One character of oversight, total failure, no warning.
//
// Run:  node scripts/check-icons.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'src');

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = join(dir, e.name);
  return e.isDirectory() ? walk(p) : (/\.jsx?$/.test(e.name) ? [p] : []);
});

const iconsFile = join(SRC, 'components', 'Icons.jsx');
const icons = readFileSync(iconsFile, 'utf8');
// Covers both `export const Zap = make(...)` and alias forms like `export const Volume2 = Volume;`
const exported = new Set([...icons.matchAll(/export\s+const\s+(\w+)\s*=/g)].map((m) => m[1]));

let problems = 0;
for (const file of walk(SRC)) {
  const s = readFileSync(file, 'utf8');
  const imp = s.match(/import\s*\{([^}]*)\}\s*from\s*'[^']*Icons(?:\.jsx)?'/);
  const imported = imp
    ? new Set(imp[1].split(',').map((x) => x.trim()).filter(Boolean))
    : new Set();

  const notExported = [...imported].filter((n) => !exported.has(n)).sort();
  // Only flag names Icons.jsx actually provides — anything else is a component import.
  const used = new Set([...s.matchAll(/<([A-Z]\w*)[\s/>]/g)].map((m) => m[1]));
  const notImported = [...used].filter((n) => exported.has(n) && !imported.has(n)).sort();

  if (notExported.length || notImported.length) {
    problems += notExported.length + notImported.length;
    console.log(`  ${relative(ROOT, file)}`);
    if (notImported.length) console.log(`     used but NOT imported:            ${notImported.join(', ')}`);
    if (notExported.length) console.log(`     imported but Icons.jsx lacks it:  ${notExported.join(', ')}`);
  }
}

console.log(problems
  ? `\nFAILED — ${problems} icon reference${problems === 1 ? '' : 's'} would throw at runtime`
  : `\nPASSED — every icon reference resolves (${exported.size} icons exported)`);
process.exit(problems ? 1 : 0);
