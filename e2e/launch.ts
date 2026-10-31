// Every isolated fixture keeps Chromium's sandbox, including its auxiliary profiles.
import { chromium } from "playwright-core";

type Options = NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]> & {
  executablePath: string;
};

export async function launchFixture(profile: string, options: Options) {
  if (
    options.chromiumSandbox === false ||
    options.args?.some((arg) =>
      /^--(?:no-sandbox|disable-(?:setuid|namespace|seccomp-filter|gpu)-sandbox)(?:=|$)/.test(arg),
    )
  ) {
    throw new Error("fixtures require Chromium sandbox");
  }
  // Playwright otherwise appends --no-sandbox, even when the fixture never asks for it.
  return chromium.launchPersistentContext(profile, { ...options, chromiumSandbox: true });
}
