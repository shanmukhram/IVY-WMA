import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { AppIcon, SourceTile, brandFor, normaliseApp } from "../src/components/AppIcon.tsx";

describe("app icons", () => {
  it("maps platform ids, app names, Android packages and Google products to brand marks", () => {
    const cases: Array<[string, string]> = [
      ["telegram", "Telegram"], ["Telegram Desktop", "Telegram"], ["org.telegram.messenger", "Telegram"], ["telegram-desktop", "Telegram"],
      ["line", "LINE"], ["line-desktop", "LINE"], ["jp.naver.line.android", "LINE"],
      ["WhatsApp", "WhatsApp"], ["com.whatsapp", "WhatsApp"], ["instagram", "Instagram"], ["Snapchat", "Snapchat"],
      ["Search", "Google"], ["Google", "Google"], ["Maps", "Google Maps"], ["Google Maps", "Google Maps"], ["YouTube", "YouTube"],
      ["Play Store", "Google Play"], ["Google Play Store", "Google Play"], ["com.android.vending", "Google Play"],
      ["Gmail", "Gmail"], ["Chrome", "Google Chrome"], ["Google Chrome", "Google Chrome"], ["com.android.chrome", "Google Chrome"],
    ];
    for (const [id, title] of cases) expect(brandFor(id)?.title, id).toBe(title);
    for (const id of ["Microsoft Teams", "Windows Security", "sms", "", null, undefined]) expect(brandFor(id as never), String(id)).toBeNull();
    expect(normaliseApp("Telegram Desktop")).toBe("telegramdesktop");
  });

  it("renders the brand path in its colour, decorative unless labelled", () => {
    const { container } = render(<><AppIcon app="telegram" size={20} /><AppIcon app="YouTube" label="YouTube" /></>);
    const [tg, yt] = [...container.querySelectorAll("[data-app-icon]")] as HTMLElement[];
    expect(tg!.getAttribute("data-app-icon")).toBe("telegram");
    expect(tg!.getAttribute("aria-hidden")).toBe("true");
    expect(tg!.getAttribute("width")).toBe("20");
    expect(tg!.querySelector("path")!.getAttribute("fill")).toBe("#26A5E4");
    expect(yt!.getAttribute("role")).toBe("img");
    expect(yt!.getAttribute("aria-label")).toBe("YouTube");
  });

  it("very light marks sit on their own colour; unknown apps get a stable initials tile", () => {
    const { container } = render(<><AppIcon app="Snapchat" size={32} /><AppIcon app="Microsoft Teams" size={16} /><AppIcon app="Microsoft Teams" size={16} /></>);
    const [snap, a, b] = [...container.querySelectorAll("[data-app-icon]")] as HTMLElement[];
    expect(snap!.className).toContain("app-icon-tile");
    expect(snap!.style.background).toMatch(/rgb\(255, 252, 0\)|#FFFC00/i);
    expect(a!.getAttribute("data-app-icon")).toBe("fallback");
    expect(a!.getAttribute("data-initials")).toBe("MT");
    expect(a!.textContent).toBe(""); // initials are drawn by CSS, so they never pollute names or text
    expect(a!.style.background).toBe(b!.style.background);
    expect(a!.getAttribute("title")).toBe("Microsoft Teams");
  });

  it("card tiles: brand when there is one, else a neutral glyph tile", () => {
    const { container } = render(<><SourceTile name="telegram-desktop" /><SourceTile name="files" /></>);
    const tiles = container.querySelectorAll(".icon-tile");
    expect(tiles[0]!.querySelector("[data-app-icon='telegram']")!.getAttribute("width")).toBe("32");
    expect(tiles[1]!.querySelector("[data-app-icon]")).toBeNull();
    expect(tiles[1]!.querySelector("svg")).not.toBeNull();
  });
});
