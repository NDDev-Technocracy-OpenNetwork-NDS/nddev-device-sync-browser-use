// Page content as text an agent reads cheaply: an element's cleaned HTML, and the main article
// as markdown-like text, both with the search and diff views of snapshots.
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import type { Locator, Page } from "playwright-core";
import { type ViewOptions, Views } from "./text";

const html = new Views<Page>(5);
const articles = new Views<Page>(5);

export type HtmlOptions = ViewOptions & {
  locator: Locator | Page;
  /** Keeps `class` and `style` attributes. */
  includeStyles?: boolean | undefined;
};

/**
 * An element's HTML without scripts, styles, SVG and other markup an agent does not read: one
 * indented line per element or text, closing tags left out. Wrappers without attributes are
 * unwrapped, empty elements dropped, and long values cut.
 */
export async function getCleanHTML(options: HtmlOptions): Promise<string> {
  const target = "goto" in options.locator ? options.locator.locator(":root") : options.locator;
  const page = target.page();
  const view = await target.first().evaluate((root, includeStyles) => {
    const dropped = new Set([
      "script",
      "style",
      "svg",
      "head",
      "noscript",
      "template",
      "link",
      "meta",
    ]);
    const empty = new Set(["img", "input", "br", "hr", "area", "source", "track", "embed", "col"]);
    const kept = new Set(["href", "src", "alt", "title", "name", "type", "value", "placeholder"]);
    for (const name of ["role", "for", "action", "method", "checked", "selected", "disabled"]) {
      kept.add(name);
    }
    for (const name of ["id", "label", "target", "rel", "colspan", "rowspan"]) kept.add(name);
    const cut = (text: string, limit: number) =>
      text.length > limit ? `${text.slice(0, limit)}…` : text;
    const lines: string[] = [];
    const walk = (node: Node, depth: number) => {
      const indent = "  ".repeat(depth);
      if (node.nodeType === Node.TEXT_NODE) {
        const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
        if (text) lines.push(`${indent}${cut(text, 300)}`);
        return;
      }
      if (!(node instanceof Element)) return;
      const tag = node.tagName.toLowerCase();
      if (dropped.has(tag)) return;
      const attributes = [...node.attributes]
        .filter(
          ({ name }) =>
            kept.has(name) ||
            name.startsWith("aria-") ||
            name.startsWith("data-") ||
            (includeStyles && (name === "class" || name === "style")),
        )
        .map(({ name, value }) => `${name}="${cut(value, 100).replaceAll('"', "&quot;")}"`);
      if ((tag === "div" || tag === "span") && attributes.length === 0) {
        for (const child of node.childNodes) walk(child, depth);
        return;
      }
      const start = lines.length;
      lines.push(`${indent}<${tag}${attributes.length ? ` ${attributes.join(" ")}` : ""}>`);
      if (empty.has(tag)) return;
      for (const child of node.childNodes) walk(child, depth + 1);
      if (lines.length === start + 1 && attributes.length === 0) lines.length = start;
    };
    walk(root, 0);
    return lines.join("\n");
  }, options.includeStyles ?? false);
  return html.show(page, `html ${target}`, `URL: ${page.url()}`, view, options);
}

/**
 * The page's main content, found by Mozilla Readability (Firefox Reader View) without
 * navigation, ads and sidebars, as text with its title, byline and excerpt.
 */
export async function getPageMarkdown(options: ViewOptions & { page: Page }): Promise<string> {
  const { page } = options;
  const { document } = parseHTML(await page.content());
  const article = new Readability(document as unknown as Document).parse();
  const header = `URL: ${page.url()}`;
  if (!article?.content) return `${header}\n\nNo readable content found`;
  const byline = [
    article.byline ? `Author: ${article.byline}` : "",
    article.siteName ? `Site: ${article.siteName}` : "",
    article.publishedTime ? `Published: ${article.publishedTime}` : "",
  ].filter(Boolean);
  const view = [
    `# ${article.title ?? ""}`,
    byline.join(" | "),
    article.excerpt ? `> ${article.excerpt}` : "",
    text(article.content),
  ]
    .filter(Boolean)
    .join("\n\n");
  return articles.show(page, "article", header, view, options);
}

// Readability's article HTML as plain text that keeps headings, lists, quotes and code.
function text(content: string): string {
  const { document } = parseHTML(`<!doctype html><html><body>${content}</body></html>`);
  const blocks: string[] = [];
  const inline = (node: Node): string => (node.textContent ?? "").replace(/\s+/g, " ").trim();
  const walk = (node: Node) => {
    if (node.nodeType !== 1) return;
    const tag = (node as Element).tagName.toLowerCase();
    const heading = /^h([1-6])$/.exec(tag);
    if (heading) blocks.push(`${"#".repeat(Number(heading[1]))} ${inline(node)}`);
    else if (tag === "p") blocks.push(inline(node));
    else if (tag === "li") blocks.push(`- ${inline(node)}`);
    else if (tag === "blockquote") blocks.push(`> ${inline(node)}`);
    else if (tag === "pre") blocks.push(`\`\`\`\n${node.textContent ?? ""}\n\`\`\``);
    else for (const child of node.childNodes) walk(child);
  };
  for (const child of document.body.childNodes) walk(child);
  return blocks.filter(Boolean).join("\n\n");
}
