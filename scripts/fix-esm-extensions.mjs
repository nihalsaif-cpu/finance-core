/**
 * Append explicit file extensions to relative specifiers in the emitted output.
 *
 * TypeScript deliberately does not rewrite module specifiers, so `import './types'`
 * comes out of tsc unchanged. Bundlers (Vite, Metro, webpack, Next) resolve that
 * happily, but Node's own ESM resolver does not — it requires a real path. Without
 * this step the package works everywhere except plain Node, which is exactly the
 * environment a test runner or a server-side consumer uses.
 *
 * Resolution mirrors Node's: prefer `<spec>.js`, fall back to `<spec>/index.js`.
 */
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(js|d\.ts)$/.test(entry.name)) yield full;
  }
}

async function replaceAsync(str, re, fn) {
  const jobs = [];
  str.replace(re, (...args) => { jobs.push(fn(...args)); return ''; });
  const done = await Promise.all(jobs);
  return str.replace(re, () => done.shift());
}

let changed = 0;
for await (const file of walk(DIST)) {
  const src = await readFile(file, 'utf8');
  const dir = path.dirname(file);
  const isTypes = file.endsWith('.d.ts');

  const out = await replaceAsync(src, /(from\s+|import\s*\()(['"])(\.\.?\/[^'"]*?)\2/g,
    async (whole, lead, quote, spec) => {
      if (/\.(js|json|mjs|cjs)$/.test(spec)) return whole;
      const base = path.resolve(dir, spec);
      const target = (await exists(base + (isTypes ? '.d.ts' : '.js')))
        ? spec + '.js'
        : (await exists(path.join(base, isTypes ? 'index.d.ts' : 'index.js')))
          ? spec + '/index.js'
          : null;
      if (!target) throw new Error(`Unresolvable specifier ${spec} in ${file}`);
      return `${lead}${quote}${target}${quote}`;
    });

  if (out !== src) { await writeFile(file, out); changed++; }
}

console.log(`fix-esm-extensions: rewrote ${changed} files`);
