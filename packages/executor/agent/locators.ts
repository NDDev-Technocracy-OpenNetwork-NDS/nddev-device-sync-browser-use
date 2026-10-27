// A stable Playwright locator string for an element, for scripts that outlive one snapshot: a
// test id, else its role and accessible name, else its id, else its tag path.
import type { Locator } from "playwright-core";

export async function getLocatorStringForElement(locator: Locator): Promise<string> {
  const element = locator.first();
  const page = element.page();
  const testId = await element.getAttribute("data-testid");
  if (testId) return `getByTestId(${JSON.stringify(testId)})`;
  const [line = ""] = (await element.ariaSnapshot()).split("\n");
  const aria = /^- (\w+) "((?:[^"\\]|\\.)*)"/.exec(line);
  const role = aria?.[1];
  if (role && role !== "generic" && aria[2]) {
    const name = JSON.parse(`"${aria[2]}"`) as string;
    const same = page.getByRole(role as Parameters<typeof page.getByRole>[0], {
      name,
      exact: true,
    });
    const handle = await element.elementHandle();
    const index = await same.evaluateAll(
      (elements, target) => elements.indexOf(target as HTMLElement),
      handle,
    );
    const base = `getByRole(${JSON.stringify(role)}, { name: ${JSON.stringify(name)}, exact: true })`;
    if (index >= 0) return (await same.count()) === 1 ? base : `${base}.nth(${index})`;
  }
  return element.evaluate((target) => {
    if (target.id && document.querySelectorAll(`#${CSS.escape(target.id)}`).length === 1) {
      return `locator(${JSON.stringify(`#${CSS.escape(target.id)}`)})`;
    }
    const path: string[] = [];
    for (
      let node: Element | null = target;
      node && node !== document.documentElement;
      node = node.parentElement
    ) {
      const parent: Element | null = node.parentElement;
      const tag = node.tagName.toLowerCase();
      const siblings = parent
        ? [...parent.children].filter((child) => child.tagName === node?.tagName)
        : [];
      path.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag);
    }
    return `locator(${JSON.stringify(path.join(" > "))})`;
  });
}
