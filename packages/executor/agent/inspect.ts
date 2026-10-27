// Layout, scroll, visibility, input and aria state of one element as text, so an agent does not
// write its own page.evaluate() for them.
import type { Locator } from "playwright-core";

const STYLES = [
  "overflow-y",
  "overflow-x",
  "position",
  "max-height",
  "display",
  "flex-direction",
  "flex-shrink",
];

export async function inspect({
  locator,
  properties = STYLES,
}: {
  locator: Locator;
  properties?: string[] | undefined;
}): Promise<string> {
  return locator.first().evaluate((element, properties) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    const classes = [...element.classList].slice(0, 3);
    const name = `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${classes.length ? `.${classes.join(".")}` : ""}`;
    const lines = [
      `Element: ${name}`,
      `Box: x=${Math.round(box.x)} y=${Math.round(box.y)} w=${Math.round(box.width)} h=${Math.round(box.height)}`,
      `Children: ${element.children.length}  Text length: ${(element.textContent ?? "").length}`,
      `Scroll Y: size=${element.scrollHeight} client=${element.clientHeight} overflowing=${element.scrollHeight > element.clientHeight} top=${Math.round(element.scrollTop)}`,
      `Scroll X: size=${element.scrollWidth} client=${element.clientWidth} overflowing=${element.scrollWidth > element.clientWidth} left=${Math.round(element.scrollLeft)}`,
      `Styles: ${properties.map((property) => `${property}=${style.getPropertyValue(property)}`).join(" ")}`,
    ];
    const hidden = [];
    if (style.opacity !== "1") hidden.push(`opacity=${style.opacity}`);
    if (style.visibility !== "visible") hidden.push(`visibility=${style.visibility}`);
    if (style.display === "none") hidden.push("display=none");
    if (style.pointerEvents === "none") hidden.push("pointer-events=none");
    if (hidden.length) lines.push(`Visibility: ${hidden.join(" ")}`);
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLButtonElement
    ) {
      const input = [`value=${JSON.stringify(element.value)}`];
      if (element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type)) {
        input.push(`checked=${element.checked}`);
      }
      if (element.disabled) input.push("disabled");
      lines.push(`Input: ${input.join(" ")}`);
    }
    const aria = [...element.attributes]
      .filter((attribute) => attribute.name.startsWith("aria-"))
      .map((attribute) => `${attribute.name}=${attribute.value}`);
    if (aria.length) lines.push(`Aria: ${aria.join(" ")}`);
    return lines.join("\n");
  }, properties);
}
