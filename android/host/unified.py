"""The unified message model (unified.db) and its idempotent ingest + FTS5 search.

One SQLite database holds normalized rows from every parsed source:

  - messages : platform, account, chat_id, chat_title, sender_id, sender_name,
               msg_id, ts_utc, body, kind, from_me, deleted_at_source, source_path
  - chats    : platform, account, chat_id, title, kind, source_path
  - contacts : platform, account, contact_id, display_name, number, source_path
  - calls    : platform, account, call_id, number, contact_name, ts_utc,
               direction, duration_s, source_path   (from contacts2.db `calls`)

Design rules (from the task and PLAN decision 24):

  - Re-ingest is IDEMPOTENT: messages merge on (platform, account, msg_id); a
    second ingest of the same source never duplicates rows.
  - A source-side delete NEVER removes a row. Captured content is never dropped:
    on merge we keep any body we already captured, and only set `deleted_at_source`.
  - msg_id is the PLATFORM's own message id, never invented here.

FTS5 over messages(body, sender_name, chat_title), kept in sync with triggers so
search reflects the current rows after any merge.

ts_utc / deleted_at_source are epoch-milliseconds UTC (integers).
from_me is 0/1. deleted_at_source is NULL when the message is live.
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field

SCHEMA = """
CREATE TABLE IF NOT EXISTS messages (
    id                INTEGER PRIMARY KEY,
    platform          TEXT NOT NULL,
    account           TEXT NOT NULL,
    chat_id           TEXT,
    chat_title        TEXT,
    sender_id         TEXT,
    sender_name       TEXT,
    msg_id            TEXT NOT NULL,
    ts_utc            INTEGER,
    body              TEXT,
    kind              TEXT,
    from_me           INTEGER,
    deleted_at_source INTEGER,
    source_path       TEXT,
    UNIQUE (platform, account, msg_id)
);

CREATE TABLE IF NOT EXISTS chats (
    platform    TEXT NOT NULL,
    account     TEXT NOT NULL,
    chat_id     TEXT NOT NULL,
    title       TEXT,
    kind        TEXT,
    source_path TEXT,
    PRIMARY KEY (platform, account, chat_id)
);

CREATE TABLE IF NOT EXISTS contacts (
    platform     TEXT NOT NULL,
    account      TEXT NOT NULL,
    contact_id   TEXT NOT NULL,
    display_name TEXT,
    number       TEXT,
    source_path  TEXT,
    PRIMARY KEY (platform, account, contact_id)
);

CREATE TABLE IF NOT EXISTS calls (
    platform     TEXT NOT NULL,
    account      TEXT NOT NULL,
    call_id      TEXT NOT NULL,
    number       TEXT,
    contact_name TEXT,
    ts_utc       INTEGER,
    direction    TEXT,
    duration_s   INTEGER,
    source_path  TEXT,
    PRIMARY KEY (platform, account, call_id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    body, sender_name, chat_title,
    content='messages', content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, body, sender_name, chat_title)
    VALUES (new.id, new.body, new.sender_name, new.chat_title);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, body, sender_name, chat_title)
    VALUES ('delete', old.id, old.body, old.sender_name, old.chat_title);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, body, sender_name, chat_title)
    VALUES ('delete', old.id, old.body, old.sender_name, old.chat_title);
    INSERT INTO messages_fts(rowid, body, sender_name, chat_title)
    VALUES (new.id, new.body, new.sender_name, new.chat_title);
END;
"""


@dataclass
class Message:
    platform: str
    account: str
    msg_id: str
    chat_id: str | None = None
    chat_title: str | None = None
    sender_id: str | None = None
    sender_name: str | None = None
    ts_utc: int | None = None
    body: str | None = None
    kind: str | None = None
    from_me: int | None = None
    deleted_at_source: int | None = None
    source_path: str | None = None


@dataclass
class Chat:
    platform: str
    account: str
    chat_id: str
    title: str | None = None
    kind: str | None = None
    source_path: str | None = None


@dataclass
class Contact:
    platform: str
    account: str
    contact_id: str
    display_name: str | None = None
    number: str | None = None
    source_path: str | None = None


@dataclass
class Call:
    platform: str
    account: str
    call_id: str
    number: str | None = None
    contact_name: str | None = None
    ts_utc: int | None = None
    direction: str | None = None
    duration_s: int | None = None
    source_path: str | None = None


@dataclass
class ParseResult:
    """What a parser emits for one source DB."""

    messages: list[Message] = field(default_factory=list)
    chats: list[Chat] = field(default_factory=list)
    contacts: list[Contact] = field(default_factory=list)
    calls: list[Call] = field(default_factory=list)


class UnifiedDB:
    """The unified model over a SQLite connection.

    Built in memory by default so no plaintext database file is written to disk;
    the ingest pipeline serializes it and stores only the encrypted image in the
    archive. `open(path)` is available for inspection/debugging.
    """

    def __init__(self, con: sqlite3.Connection):
        self.con = con
        self.con.row_factory = sqlite3.Row
        self.con.executescript(SCHEMA)
        self.con.commit()

    @classmethod
    def in_memory(cls) -> "UnifiedDB":
        return cls(sqlite3.connect(":memory:"))

    @classmethod
    def open(cls, path: str) -> "UnifiedDB":
        return cls(sqlite3.connect(path))

    @classmethod
    def from_bytes(cls, data: bytes) -> "UnifiedDB":
        """Open an existing unified.db from its raw SQLite image (for re-ingest
        and for search), fully in memory."""
        con = sqlite3.connect(":memory:")
        con.deserialize(data)
        return cls(con)

    def serialize(self) -> bytes:
        """Return the raw SQLite image of the whole database (incl. FTS shadow
        tables), ready to be encrypted into the archive."""
        return self.con.serialize()

    def close(self) -> None:
        self.con.close()

    # --- idempotent ingest ----------------------------------------------

    def merge_message(self, m: Message) -> None:
        """Insert or merge one message by (platform, account, msg_id).

        Decision 24: captured content is never removed. On conflict we keep any
        body we already captured (a later empty/deleted copy does not wipe it),
        and only set deleted_at_source. Non-empty fields from the new copy fill
        gaps and refresh metadata.
        """
        self.con.execute(
            """
            INSERT INTO messages
                (platform, account, chat_id, chat_title, sender_id, sender_name,
                 msg_id, ts_utc, body, kind, from_me, deleted_at_source, source_path)
            VALUES (:platform, :account, :chat_id, :chat_title, :sender_id,
                    :sender_name, :msg_id, :ts_utc, :body, :kind, :from_me,
                    :deleted_at_source, :source_path)
            ON CONFLICT (platform, account, msg_id) DO UPDATE SET
                chat_id           = COALESCE(excluded.chat_id, messages.chat_id),
                chat_title        = COALESCE(excluded.chat_title, messages.chat_title),
                sender_id         = COALESCE(excluded.sender_id, messages.sender_id),
                sender_name       = COALESCE(excluded.sender_name, messages.sender_name),
                ts_utc            = COALESCE(messages.ts_utc, excluded.ts_utc),
                -- never wipe captured text: keep ours unless we had none
                body              = CASE
                                      WHEN messages.body IS NOT NULL AND messages.body <> ''
                                        THEN messages.body
                                      ELSE COALESCE(excluded.body, messages.body)
                                    END,
                kind              = COALESCE(messages.kind, excluded.kind),
                from_me           = COALESCE(messages.from_me, excluded.from_me),
                -- a delete only marks; keep the earliest observed delete time
                deleted_at_source = COALESCE(messages.deleted_at_source,
                                             excluded.deleted_at_source),
                source_path       = COALESCE(messages.source_path, excluded.source_path)
            """,
            m.__dict__,
        )

    def merge_chat(self, c: Chat) -> None:
        self.con.execute(
            """
            INSERT INTO chats (platform, account, chat_id, title, kind, source_path)
            VALUES (:platform, :account, :chat_id, :title, :kind, :source_path)
            ON CONFLICT (platform, account, chat_id) DO UPDATE SET
                title       = COALESCE(excluded.title, chats.title),
                kind        = COALESCE(excluded.kind, chats.kind),
                source_path = COALESCE(excluded.source_path, chats.source_path)
            """,
            c.__dict__,
        )

    def merge_contact(self, c: Contact) -> None:
        self.con.execute(
            """
            INSERT INTO contacts
                (platform, account, contact_id, display_name, number, source_path)
            VALUES (:platform, :account, :contact_id, :display_name, :number, :source_path)
            ON CONFLICT (platform, account, contact_id) DO UPDATE SET
                display_name = COALESCE(excluded.display_name, contacts.display_name),
                number       = COALESCE(excluded.number, contacts.number),
                source_path  = COALESCE(excluded.source_path, contacts.source_path)
            """,
            c.__dict__,
        )

    def merge_call(self, c: Call) -> None:
        self.con.execute(
            """
            INSERT INTO calls
                (platform, account, call_id, number, contact_name, ts_utc,
                 direction, duration_s, source_path)
            VALUES (:platform, :account, :call_id, :number, :contact_name, :ts_utc,
                    :direction, :duration_s, :source_path)
            ON CONFLICT (platform, account, call_id) DO UPDATE SET
                number       = COALESCE(excluded.number, calls.number),
                contact_name = COALESCE(excluded.contact_name, calls.contact_name),
                ts_utc       = COALESCE(calls.ts_utc, excluded.ts_utc),
                direction    = COALESCE(excluded.direction, calls.direction),
                duration_s   = COALESCE(excluded.duration_s, calls.duration_s),
                source_path  = COALESCE(excluded.source_path, calls.source_path)
            """,
            c.__dict__,
        )

    def ingest(self, result: ParseResult) -> None:
        for c in result.chats:
            self.merge_chat(c)
        for c in result.contacts:
            self.merge_contact(c)
        for m in result.messages:
            self.merge_message(m)
        for c in result.calls:
            self.merge_call(c)
        self.con.commit()

    # --- search ----------------------------------------------------------

    def search(self, query: str, limit: int = 50) -> list[sqlite3.Row]:
        """FTS5 search over body/sender_name/chat_title, newest first."""
        return list(
            self.con.execute(
                """
                SELECT m.platform, m.account, m.chat_id, m.chat_title, m.sender_id,
                       m.sender_name, m.ts_utc, m.body, m.kind, m.from_me,
                       m.deleted_at_source
                FROM messages_fts
                JOIN messages m ON m.id = messages_fts.rowid
                WHERE messages_fts MATCH ?
                ORDER BY m.ts_utc DESC
                LIMIT ?
                """,
                (query, limit),
            )
        )

    def counts(self) -> dict:
        cur = self.con.cursor()
        out = {}
        for t in ("messages", "chats", "contacts", "calls"):
            out[t] = cur.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
        return out
