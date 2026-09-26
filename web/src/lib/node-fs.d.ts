/**
 * The one Node API the tests use, typed without pulling Node's typings into an
 * app that runs in a browser (theme.test.ts reads the stylesheet as text).
 */
declare module "node:fs" {
  export function readFileSync(path: URL | string, encoding: "utf8"): string;
}
