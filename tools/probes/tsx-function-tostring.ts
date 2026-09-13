/**
 * Settled for B-125 (2026-09-13, tsx 4.23): can a worker be given a TS function's source via
 * `fn.toString()`?
 *
 *   pnpm exec tsx tools/probes/tsx-function-tostring.ts
 *
 * prints, minified by tsx's esbuild transform:
 *
 *   function scan(contents,flags){...const count=__name(s=>...,"count");class Box{static{__name(this,"Box")}...
 *
 * `__name` is a helper tsx injects for inner arrow functions and classes; it exists in the module
 * that defined `scan`, not in an eval'd worker, so that worker would throw a ReferenceError in dev
 * (tsx) and work under vitest and the esbuild sidecar bundle. That is why
 * `packages/server/src/ops/replace-scan.ts` writes its worker body as a plain JavaScript string.
 */
export function scan(contents: string[], flags: string): number[] {
  const re = new RegExp("a", flags);
  const count = (s: string): number => [...s.matchAll(re)].length;
  class Box {
    v = 0;
  }
  return contents.map((c) => count(c) + new Box().v);
}

console.log(scan.toString());
