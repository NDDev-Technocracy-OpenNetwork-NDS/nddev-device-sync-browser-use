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
 * indented line per block element, closing tags left out, and inline elements (links, code,
 * emphasis) kept within their sentence. Wrappers without attributes are unwrapped, empty
 * elements dropped, and long values cut.
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
    for (const name of ["id", "label", "target", "colspan", "rowspan"]) kept.add(name);
    const cut = (text: string, limit: number) =>
      text.length > limit ? `${text.slice(0, limit)}…` : text;
    // Text-level elements stay within their sentence; a line per element would split it.
    const inline = new Set(["a", "abbr", "b", "bdi", "bdo", "cite", "code", "data", "dfn", "em"]);
    for (const tag of ["i", "kbd", "label", "mark", "q", "s", "samp", "small", "span", "strong"]) {
      inline.add(tag);
    }
    for (const tag of ["sub", "sup", "time", "u", "var", "img", "br"]) inline.add(tag);
    const origin = `${location.origin}/`;
    // Attributes that say something: data-* test hooks but not serialized state, a title only
    // when it adds to the text, and this site's links as paths.
    const said = (node: Element, name: string, value: string) =>
      name.startsWith("data-")
        ? value.length <= 40 && !/^\s*[[{]/.test(value)
        : name !== "title" || value.trim() !== (node.textContent ?? "").trim();
    const attributesOf = (node: Element) =>
      [...node.attributes]
        .filter(
          ({ name, value }) =>
            (kept.has(name) ||
              name.startsWith("aria-") ||
              name.startsWith("data-") ||
              (includeStyles && (name === "class" || name === "style"))) &&
            said(node, name, value),
        )
        .map(({ name, value }) => {
          const short =
            (name === "href" || name === "src" || name === "action") && value.startsWith(origin)
              ? value.slice(origin.length - 1)
              : value;
          return `${name}="${cut(short, 100).replaceAll('"', "&quot;")}"`;
        });
    const open = (tag: string, attributes: string[]) =>
      `<${tag}${attributes.length ? ` ${attributes.join(" ")}` : ""}>`;
    // Text, and inline elements holding only text and inline elements.
    const isInline = (node: Node): boolean => {
      if (node.nodeType === Node.TEXT_NODE) return true;
      if (!(node instanceof Element)) return true;
      const tag = node.tagName.toLowerCase();
      return dropped.has(tag) || (inline.has(tag) && [...node.childNodes].every(isInline));
    };
    const flat = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) {
        return cut((node.textContent ?? "").replace(/\s+/g, " "), 300);
      }
      if (!(node instanceof Element)) return "";
      const tag = node.tagName.toLowerCase();
      if (dropped.has(tag)) return "";
      const attributes = attributesOf(node);
      const inner = [...node.childNodes].map(flat).join("");
      // An inline span says nothing but its text, even with an id of its own.
      if (tag === "span" && attributes.every((attribute) => attribute.startsWith("id="))) {
        return inner;
      }
      if (empty.has(tag)) return open(tag, attributes);
      if (!inner.trim() && attributes.length === 0) return "";
      return `${open(tag, attributes)}${inner}</${tag}>`;
    };
    const lines: string[] = [];
    const walk = (node: Node, depth: number) => {
      const indent = "  ".repeat(depth);
      if (node.nodeType === Node.TEXT_NODE || (node instanceof Element && isInline(node))) {
        const text = flat(node).replace(/\s+/g, " ").trim();
        if (text) lines.push(`${indent}${text}`);
        return;
      }
      if (!(node instanceof Element)) return;
      const tag = node.tagName.toLowerCase();
      const attributes = attributesOf(node);
      if ((tag === "div" || tag === "span") && attributes.length === 0) {
        children(node, depth);
        return;
      }
      const start = lines.length;
      // A block of text and inline elements only is one line: the tag and its sentence.
      if (!empty.has(tag) && [...node.childNodes].every(isInline)) {
        const text = [...node.childNodes].map(flat).join("").replace(/\s+/g, " ").trim();
        if (text || attributes.length > 0) lines.push(`${indent}${open(tag, attributes)}${text}`);
        return;
      }
      lines.push(`${indent}${open(tag, attributes)}`);
      if (empty.has(tag)) return;
      children(node, depth + 1);
      if (lines.length === start + 1 && attributes.length === 0) lines.length = start;
    };
    // Consecutive text and inline children form one line, so a sentence stays whole.
    const children = (node: Node, depth: number) => {
      let run: Node[] = [];
      const flush = () => {
        const text = run.map(flat).join("").replace(/\s+/g, " ").trim();
        if (text) lines.push(`${"  ".repeat(depth)}${text}`);
        run = [];
      };
      for (const child of node.childNodes) {
        if (isInline(child)) run.push(child);
        else {
          flush();
          walk(child, depth);
        }
      }
      flush();
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
  const body = article?.content ? text(article.content) : "";
  // Listings, tables and apps have no article: Readability keeps a heading or nothing of them.
  // Their visible text stands in when it holds four times as much.
  const visible = await page
    // biome-ignore lint/performance/useDomNodeTextContent: the rendered text, without hidden parts and with its line breaks, is the point.
    .evaluate(() => document.body?.innerText ?? "")
    .then(lines)
    .catch(() => "");
  if (visible && body.length * 4 < visible.length) {
    const title = await page.title().catch(() => "");
    const view = [`# ${title}`, "(no main article: the page's visible text)", visible].join("\n\n");
    return articles.show(page, "article", header, view, options);
  }
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
    body,
  ]
    .filter(Boolean)
    .join("\n\n");
  return articles.show(page, "article", header, view, options);
}

// A page's innerText without blank runs and with one space between table cells.
function lines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .filter((line, index, all) => line !== "" || (all[index - 1] ?? "") !== "")
    .join("\n")
    .trim();
}

// Readability's article HTML as plain text that keeps headings, lists, quotes, code and tables.
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
    else if (tag === "tr") {
      const cells = [...(node as Element).children].map(inline).filter(Boolean);
      if (cells.length > 0) blocks.push(`| ${cells.join(" | ")} |`);
    } else if (["dt", "dd", "figcaption", "caption", "summary"].includes(tag)) {
      blocks.push(inline(node));
    } else if (
      // Text written straight into a wrapper, outside any paragraph.
      [...node.childNodes].some((child) => child.nodeType === 3 && child.textContent?.trim())
    ) {
      blocks.push(inline(node));
    } else for (const child of node.childNodes) walk(child);
  };
  for (const child of document.body.childNodes) walk(child);
  return blocks.filter(Boolean).join("\n\n");
}
