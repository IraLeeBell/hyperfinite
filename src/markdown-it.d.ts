// Minimal ambient typing for the subset of markdown-it's token API used by
// checkMarkdownLinkClosure in src/customer-starter.ts. markdown-it ships no
// bundled type declarations and no @types/markdown-it package is installed
// (mirrors the existing src/spdx-expression-parse.d.ts precedent).
declare module "markdown-it" {
  export interface Token {
    readonly type: string;
    readonly content: string;
    readonly children: readonly Token[] | null;
    attrGet(name: string): string | null;
  }

  export interface MarkdownItOptions {
    readonly html?: boolean;
    readonly linkify?: boolean;
    readonly typographer?: boolean;
  }

  export default class MarkdownIt {
    constructor(options?: MarkdownItOptions);
    parse(source: string, env: Readonly<Record<string, unknown>>): Token[];
  }
}
