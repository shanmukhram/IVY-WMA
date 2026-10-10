import { describe, it, expect } from "vitest";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FilesView } from "../src/views/Files.tsx";
import { applyEvent, describe as describeReq, fromCommand } from "../src/request.ts";
import { mockApi, renderWith } from "./helpers.tsx";

const file = { type: "file", id: "f1", deviceId: "d1", app: null, eventTime: "2026-09-20T08:00:00.000Z", timeField: "mtime", capturedAt: "2026-10-01T00:00:00.000Z",
  title: "invoice.pdf", body: "C:\\invoice.pdf", person: null, detail: { name: "invoice.pdf", path: "C:\\invoice.pdf", size: 900, availability: "reference", contentUrl: null, lastRequest: null } };
const cmd = (over: Record<string, unknown> = {}) => ({ id: "c1", fileId: "f1", status: "queued", display: "queued", waitingOn: "mac", detail: null, resultOid: null, progress: null, ...over });

describe("request original", () => {
  it("moves queued -> in progress with byte progress -> done, driven by events", async () => {
    const api = mockApi({
      "GET /api/files": { total: 1, page: 1, pageSize: 50, items: [file] },
      "GET /api/devices": { devices: [{ id: "d1", role: "windows" }] },
      "POST /api/files/f1/request": { command: cmd(), reused: false },
      "GET /api/commands/c1": cmd({ status: "uploaded", waitingOn: "transfer", resultOid: "OID1", progress: { committedParts: 0, totalChunks: 4, committedBytes: 0, totalSize: 1000 } }),
    });
    const { events } = renderWith(<FilesView />, api, { path: "/files" });
    expect(await screen.findByText(/reference only/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Request original" }));
    expect(await screen.findByTestId("request-status")).toHaveTextContent("queued on the Mac");
    expect(screen.queryByRole("button", { name: "Request original" })).toBeNull();

    act(() => events.emit("command.sent", { commandId: "c1" }));
    expect(screen.getByTestId("request-status")).toHaveTextContent("waiting for the device");
    act(() => events.emit("command.sent", { commandId: "other" }));
    expect(screen.getByTestId("request-status")).toHaveTextContent("waiting for the device");

    act(() => events.emit("command.status", { commandId: "c1", status: "uploaded", resultOid: "OID1" }));
    expect(await screen.findByText(/0 of 1000 bytes/)).toBeInTheDocument();
    act(() => events.emit("blob.progress", { oid: "OID1", committedBytes: 500, totalSize: 1000 }));
    expect(screen.getByTestId("request-status")).toHaveTextContent("500 of 1000 bytes (50%)");
    act(() => events.emit("blob.progress", { oid: "SOMETHING_ELSE", committedBytes: 900, totalSize: 1000 }));
    expect(screen.getByTestId("request-status")).toHaveTextContent("50%");

    api.routes["GET /api/files"] = { total: 1, page: 1, pageSize: 50, items: [{ ...file, detail: { ...file.detail, availability: "local", contentUrl: "/api/files/f1/content" } }] };
    act(() => events.emit("file.cached", { fileId: "f1", commandId: "c1" }));
    expect(screen.getByTestId("request-status")).toHaveTextContent("done: local copy available");
    expect(await screen.findByRole("link", { name: "Open local copy" })).toHaveAttribute("href", "/api/files/f1/content");
  });

  it("a failed request shows the device's status and offers the button again", () => {
    let s = fromCommand(cmd({ status: "sent", waitingOn: "device" }) as never);
    s = applyEvent(s, { at: "", type: "command.status", data: { commandId: "c1", status: "not_found", detail: "no such file" } });
    expect(s.phase).toBe("failed");
    expect(describeReq(s)).toBe("failed: not_found (no such file)");
  });
});
