import { describe, it, expect } from "vitest";
import path from "node:path";
import { slash, endsWithSegments } from "./helpers/paths.ts";

describe("test path helpers", () => {
  it("slash() normalises Windows separators and leaves POSIX paths alone", () => {
    expect(slash("C:\\w\\d\\files\\X\\a.pdf")).toBe("C:/w/d/files/X/a.pdf");
    expect(slash("/w/d/files")).toBe("/w/d/files");
  });

  it("endsWithSegments() matches by segment, not by separator or substring", () => {
    expect(endsWithSegments("C:\\w\\d\\media\\abc.png", "media", "abc.png")).toBe(true);
    expect(endsWithSegments("/w/d/media/abc.png", "media", "abc.png")).toBe(true);
    expect(endsWithSegments("/w/d/xmedia/abc.png", "media", "abc.png")).toBe(false);
    expect(endsWithSegments("abc.png", "media", "abc.png")).toBe(false);
  });

  it("path.win32 resolution used by the expectations behaves as assumed", () => {
    expect(path.win32.resolve("C:\\w", "d")).toBe("C:\\w\\d");
    expect(path.win32.join(path.win32.resolve("C:\\tmp\\ivy\\mac\\service"), "..", "ui", "dist")).toBe("C:\\tmp\\ivy\\mac\\ui\\dist");
    expect(path.win32.isAbsolute(path.win32.resolve("C:\\w", "/abs/ui"))).toBe(true);
    expect(slash(path.win32.join("C:\\w\\d", "files", "X", "a.pdf"))).toBe("C:/w/d/files/X/a.pdf");
  });
});
