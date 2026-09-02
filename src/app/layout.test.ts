import { describe, expect, it } from "vitest";

import RootLayout, { metadata } from "./layout";

describe("the application shell", () => {
  it("serves the interface in French", () => {
    const shell = RootLayout({ children: null });

    expect(shell.props.lang).toBe("fr");
  });

  it("is titled in French", () => {
    expect(metadata.title).toBe("Vérificateur de terpnos logos");
  });
});
