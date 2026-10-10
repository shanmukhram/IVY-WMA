/** Shared mock data for the UI tests. */
export const WIN = "11111111-2222-3333-4444-555555555555";
export const now = new Date().toISOString();

export const coverage = {
  at: now, locked: false, r2Configured: true, status: "red",
  problems: [
    { severity: "red", source: { deviceId: WIN, role: "windows", collector: "usage" }, message: "windows usage: last run 3 h ago" },
    { severity: "amber", source: { bucket: "ivy-up-windows" }, message: "1 object(s) quarantined in ivy-up-windows" },
  ],
  devices: [{
    deviceId: WIN, role: "windows", fingerprint: "AAAA-BBBB-CCCC-DDDD", pairedAt: now, lastSeen: now, lastReportAt: now, reportStatus: "green",
    appVersion: "0.1.0", queueDepthTotal: 7, status: "red", quarantined: 1, queuedCommands: 0, counts: {}, pendingBlobs: [],
    collectors: [
      { name: "files", enabled: true, lastRunAt: now, lastReportAt: now, queueDepth: 7, status: "green", statusReason: "running", captures: "File index", captureKind: "metadata",
        import: { indexed: 250, total: 1000, percent: 25, state: "in_progress", note: null } },
      { name: "usage", enabled: true, lastRunAt: now, lastReportAt: now, queueDepth: 0, status: "red", statusReason: "last run 3 h ago", captures: "Foreground app spans", captureKind: "metadata", import: null },
      { name: "screenshots", enabled: false, lastRunAt: null, lastReportAt: now, queueDepth: 0, status: "off", statusReason: "disabled on the device", captures: "Screenshots", captureKind: "media", import: null },
    ],
    gaps: [{ collector: "usage", from: "2026-10-09T10:00:00.000Z", to: "2026-10-09T11:30:00.000Z", reason: "stale", open: false }],
  }],
  buckets: [{ bucket: "ivy-up-windows", lastPollAt: now, lastSuccessAt: now, ok: true, error: null }],
  imports: [],
  unpairedRoles: ["android"], quarantineOpen: 1,
};

export const sources = { sources: [
  { source: "windows:telegram-desktop", role: "windows", collector: "telegram-desktop", platform: "telegram", conversations: 3, messages: 12, lastMessageAt: now },
  { source: "windows:line-desktop", role: "windows", collector: "line-desktop", platform: "line", conversations: 2, messages: 5, lastMessageAt: now },
] };

/** Everything the unlocked shell asks for, so a test only adds what its view needs. */
export const shellRoutes = {
  "GET /api/stats": { counts: { messages: 0, notifications: 0, media: 0, files: 0, usage: 0, calls: 0 }, lastSync: [] },
  "GET /api/activity": { events: [] },
  "GET /api/devices": { macFingerprint: "MAC1-MAC2-MAC3-MAC4", devices: [{ id: WIN, role: "windows", fingerprint: "AAAA-BBBB-CCCC-DDDD" }] },
  "GET /api/coverage": coverage,
  "GET /api/views/sources": sources,
  "GET /api/facets": { devices: [], apps: [], accounts: [], conversations: [] },
};

export const item = (over: Record<string, unknown>) => ({
  type: "file", id: "f1", deviceId: WIN, app: null, eventTime: "2026-09-23T09:00:00.000Z", timeField: "mtime", capturedAt: "2026-10-01T10:00:00.000Z",
  title: "Robotics Collaboration Offer.pdf", body: "C:\\Docs\\Robotics Collaboration Offer.pdf", person: null, match: "exact", typos: 0,
  snippetHtml: "C:\\Docs\\Robotics <mark>Collab</mark>oration Offer.pdf", detail: { availability: "reference", size: 10, name: "Robotics Collaboration Offer.pdf" }, ...over,
});
