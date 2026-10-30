// Page content as text an agent reads cheaply: an element's cleaned HTML, and the main content
// as Markdown, both with the search and diff views of snapshots.
import { htmlToMarkdown } from "@mdream/js";
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
        return cut((node.textContent ?? "").replace(/\s+/g, " "), 1000);
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

export type MarkdownOptions = ViewOptions & {
  page: Page;
  /** Reads only this part instead of the page's main content. */
  locator?: Locator | undefined;
  /** Keeps links as `[text](url)`; by default only their text, which costs fewer tokens. */
  links?: boolean | undefined;
};

/**
 * The page's main content as Markdown: headings, paragraphs, lists, tables, quotes and code
 * blocks, without navigation, headers, footers, sidebars, buttons, media and hidden parts. The
 * page itself walks its live tree, open shadow roots included, into a minimal HTML of these
 * elements, and mdream turns that into Markdown.
 */
export async function getPageMarkdown(options: MarkdownOptions): Promise<string> {
  const { page } = options;
  const header = `URL: ${page.url()}`;
  // Runs in the page: the root is the element to read, or the document element for the page's
  // main part.
  const outline = (root: Element, links: boolean): Outline => {
    const length = (element: Element | null) =>
      (element?.textContent ?? "").replace(/\s+/g, " ").length;
    const body = document.body;
    // The page's main part when it holds a fair share of the text; else the whole body.
    const main =
      root !== document.documentElement
        ? root
        : ([...document.querySelectorAll("main, [role=main], article, #content, #main")].find(
            (element) => length(element) >= length(body) * 0.3,
          ) ?? body);
    const kept = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "li", "blockquote"]);
    for (const tag of ["table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "dl"]) {
      kept.add(tag);
    }
    for (const tag of ["dt", "dd", "figcaption", "hr", "br", "strong", "b", "em", "i", "code"]) {
      kept.add(tag);
    }
    for (const tag of ["del", "s", "kbd", "mark", "q"]) kept.add(tag);
    const inline = new Set(["span", "a", "abbr", "label", "small", "time", "cite", "dfn", "u"]);
    inline.add("sub");
    inline.add("sup");
    const dropped = new Set(["script", "style", "noscript", "template", "svg", "canvas", "iframe"]);
    for (const tag of ["nav", "aside", "button", "dialog", "select", "input"]) {
      dropped.add(tag);
    }
    for (const tag of ["textarea", "img", "picture", "video", "audio", "object", "embed", "map"]) {
      dropped.add(tag);
    }
    const roles = new Set(["navigation", "banner", "contentinfo", "complementary", "search"]);
    for (const role of ["dialog", "alertdialog", "menu", "menubar", "toolbar", "tablist"]) {
      roles.add(role);
    }
    const escaped = (text: string) =>
      text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const blocks = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "li", "hr"]);
    for (const tag of ["blockquote", "table", "thead", "tbody", "tfoot", "tr", "th", "td"]) {
      blocks.add(tag);
    }
    for (const tag of ["caption", "dl", "dt", "dd", "figcaption", "pre"]) blocks.add(tag);
    // A part of the output: its HTML, and whether it is a block (else text within a line).
    type Part = { html: string; block: boolean };
    // Inline runs between blocks become paragraphs; wrappers add no nesting of their own.
    const join = (parts: Part[]): Part => {
      if (!parts.some((part) => part.block)) {
        return { html: parts.map((part) => part.html).join(""), block: false };
      }
      let html = "";
      let run = "";
      for (const part of parts) {
        if (!part.block) run += part.html;
        else {
          if (run.trim()) html += `<p>${run}</p>`;
          run = "";
          html += part.html;
        }
      }
      if (run.trim()) html += `<p>${run}</p>`;
      return { html, block: true };
    };
    const walk = (node: Node): Part => {
      if (node.nodeType === Node.TEXT_NODE) {
        return { html: escaped(node.textContent ?? ""), block: false };
      }
      if (!(node instanceof Element)) return { html: "", block: false };
      const tag = node.localName;
      if (dropped.has(tag) || (node !== main && roles.has(node.getAttribute("role") ?? ""))) {
        return { html: "", block: false };
      }
      // `display: contents` has no box of its own, yet its children render.
      const visible = node.checkVisibility() || getComputedStyle(node).display === "contents";
      if (!visible || node.getAttribute("aria-hidden") === "true") {
        return { html: "", block: false };
      }
      // A header or footer outside any article or section is the page's banner or footer; one
      // inside belongs to that part, such as an article's title and byline.
      if (
        (tag === "header" || tag === "footer") &&
        node.parentElement?.closest("article, aside, main, nav, section") === null
      ) {
        return { html: "", block: false };
      }
      // A footnote mark such as Wikipedia's "[5]" only points elsewhere on the page.
      if (
        (tag === "sup" || tag === "sub") &&
        node.querySelector('a[href^="#"]') !== null &&
        (node.textContent ?? "").trim().length <= 12
      ) {
        return { html: "", block: false };
      }
      if (tag === "pre") {
        const language = /language-(\S+)/.exec(
          `${node.className} ${node.querySelector("code")?.className ?? ""}`,
        )?.[1];
        const code = escaped(node.textContent ?? "");
        return {
          html: `<pre><code${language ? ` class="language-${language}"` : ""}>${code}</code></pre>`,
          block: true,
        };
      }
      // An open shadow root renders instead of its host's children, which its slots place.
      const children =
        node.shadowRoot !== null
          ? [...node.shadowRoot.childNodes]
          : tag === "slot"
            ? (node as HTMLSlotElement).assignedNodes({ flatten: true })
            : [...node.childNodes];
      const inner = join(children.map(walk));
      if (tag === "a") {
        const href = (node as HTMLAnchorElement).href;
        return links && href && !href.startsWith("javascript:") && inner.html.trim() && !inner.block
          ? {
              html: `<a href="${escaped(href).replace(/"/g, "&quot;")}">${inner.html}</a>`,
              block: false,
            }
          : inner;
      }
      if (blocks.has(tag)) {
        return inner.html.trim() || tag === "hr" || tag === "td" || tag === "th"
          ? { html: `<${tag}>${inner.html}</${tag}>`, block: true }
          : { html: "", block: false };
      }
      if (kept.has(tag)) {
        return inner.html.trim() && !inner.block
          ? { html: `<${tag}>${inner.html}</${tag}>`, block: false }
          : inner;
      }
      if (inline.has(tag) || inner.block) return inner;
      // Any other element with text of its own is a block: a paragraph apart from its neighbours.
      return inner.html.trim() ? { html: `<p>${inner.html}</p>`, block: true } : inner;
    };
    const meta = (name: string) =>
      document
        .querySelector(`meta[name="${name}"], meta[property="${name}"]`)
        ?.getAttribute("content")
        ?.trim() ?? "";
    return {
      title: document.title.trim(),
      description: meta("description") || meta("og:description"),
      author: meta("author"),
      published: meta("article:published_time"),
      html: walk(main).html,
    };
  };
  const links = options.links ?? false;
  const part = await (options.locator ?? page.locator(":root")).first().evaluate(outline, links);
  const body = htmlToMarkdown(part.html, { origin: page.url() })
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!body) return `${header}\n\nNo readable content found`;
  const byline = [
    part.author ? `Author: ${part.author}` : "",
    part.published ? `Published: ${part.published}` : "",
  ].filter(Boolean);
  const view = [
    part.title ? `# ${part.title}` : "",
    byline.join(" | "),
    part.description && !body.includes(part.description) ? `> ${part.description}` : "",
    body,
  ]
    .filter(Boolean)
    .join("\n\n");
  return articles.show(page, "article", header, view, options);
}

type Outline = {
  title: string;
  description: string;
  author: string;
  published: string;
  html: string;
};
