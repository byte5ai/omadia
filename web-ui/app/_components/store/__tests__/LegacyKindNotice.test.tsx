import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithIntl } from "../../../_lib/test-utils";
import { LegacyKindNotice } from "../LegacyKindNotice";

/**
 * Spec 2042 §5.10, the contract step — an installed plugin of a retired kind
 * runs on as legacy; its page says so and what replaces it.
 */
describe("<LegacyKindNotice />", () => {
  it("an agent plugin: legacy, rebuild as a capability plus an agent", () => {
    renderWithIntl(<LegacyKindNotice kind="agent" />);
    expect(screen.getByRole("note").textContent).toContain("Legacy plugin");
    expect(screen.getByText(/retired kind 'agent'/)).toBeTruthy();
    expect(
      screen.getByText(/Rebuild it in the Plugin Builder as a capability/),
    ).toBeTruthy();
  });

  it("an extension: runs as a system module, the successor declares system-module or model", () => {
    renderWithIntl(<LegacyKindNotice kind="extension" />);
    expect(screen.getByText(/retired kind 'extension'/)).toBeTruthy();
    expect(screen.getByText(/'system-module'/)).toBeTruthy();
  });

  it("renders nothing for a current kind", () => {
    for (const kind of [
      "tool",
      "integration",
      "system-module",
      "model",
    ] as const) {
      const { container, unmount } = renderWithIntl(
        <LegacyKindNotice kind={kind} />,
      );
      expect(container.textContent).toBe("");
      unmount();
    }
  });
});
