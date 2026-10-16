"""WhatsApp / WhatsApp Business parser: msgstore.db -> messages+chats, wa.db -> contacts.

Pinned to the MODERN (normalized) WhatsApp schema (2021+), which splits what the
old single `messages` table held into `message` + `chat` + `jid`:

  message._id              row id
  message.chat_row_id   -> chat._id
  message.from_me          0/1
  message.key_id           the platform's own message id (-> msg_id)
  message.sender_jid_row_id-> jid._id (group sender; NULL / self for 1:1 outgoing)
  message.timestamp        epoch-ms
  message.message_type     0 text, else media (mapped to `kind`)
  message.text_data        body
  chat.jid_row_id       -> jid._id (the conversation jid)
  chat.subject             group subject (title)
  jid.raw_string           "<user>@s.whatsapp.net" (dm) / "<id>@g.us" (group)
  jid.server               "s.whatsapp.net" | "g.us" | ...

Deletion surface (optional, not required for verification): the `message_revoked`
table lists revoked message rows ("This message was deleted"). msgstore does not
record WHEN the delete was observed, so we mark such messages deleted_at_source
using the message's own timestamp as the only available marker. Per PLAN decision
24 the row and any captured body are kept; we only set the flag.

wa.db `wa_contacts`: jid, display_name, number -> contacts.

If the real DB is the OLD single-`messages` schema (or any columns are missing),
verification fails and the source is skipped red-on-drift with zero rows.

Verified documented schema recorded in docs/findings.md.
"""
from __future__ import annotations

from unified import Call, Chat, Contact, Message, ParseResult

from .base import (
    DriftError,
    SourceMap,
    log_drift,
    open_ro,
    plausible_ms,
    table_exists,
    verify_map,
)

PLATFORM = "whatsapp"

MSGSTORE_MAP = SourceMap(
    name="whatsapp.msgstore",
    required={
        "message": [
            "_id",
            "chat_row_id",
            "from_me",
            "key_id",
            "sender_jid_row_id",
            "timestamp",
            "message_type",
            "text_data",
        ],
        "chat": ["_id", "jid_row_id", "subject"],
        "jid": ["_id", "user", "server", "raw_string"],
    },
)

WA_CONTACTS_MAP = SourceMap(
    name="whatsapp.wa_contacts",
    required={"wa_contacts": ["jid", "display_name", "number"]},
)

# message_type -> unified kind. Defaults to "other" for unmapped media types; 0 is text.
MSG_KIND = {
    0: "text",
    1: "image",
    2: "audio",
    3: "video",
    4: "contact",
    5: "location",
    7: "system",
    9: "document",
    13: "gif",
    14: "deleted",
    15: "system",
    20: "sticker",
}


def parse_msgstore(path: str, account: str, source_path: str) -> ParseResult:
    """Parse one msgstore.db. account is 'whatsapp' or 'whatsapp_business'."""
    res = ParseResult()
    con = open_ro(path)
    try:
        try:
            verify_map(con, MSGSTORE_MAP)
        except DriftError as e:
            log_drift(source_path, f"{MSGSTORE_MAP.name}: {e}")
            return res

        # Sample-row verification: if there are messages, one must parse with a
        # plausible timestamp. An empty store is allowed (verified, zero rows).
        sample = con.execute(
            "SELECT timestamp FROM message WHERE timestamp IS NOT NULL "
            "ORDER BY _id LIMIT 1"
        ).fetchone()
        if sample is not None and not plausible_ms(sample[0]):
            log_drift(
                source_path,
                f"{MSGSTORE_MAP.name}: sample message.timestamp {sample[0]} implausible",
            )
            return res

        revoked: set[int] = set()
        if table_exists(con, "message_revoked"):
            cols = {r[1] for r in con.execute('PRAGMA table_info("message_revoked")')}
            if "message_row_id" in cols:
                revoked = {
                    r[0]
                    for r in con.execute(
                        "SELECT message_row_id FROM message_revoked"
                    )
                }

        # Chats
        for r in con.execute(
            """
            SELECT cj.raw_string AS chat_jid, cj.server AS server, c.subject AS subject
            FROM chat c
            JOIN jid cj ON cj._id = c.jid_row_id
            """
        ):
            if not r["chat_jid"]:
                continue
            kind = "group" if (r["server"] or "").endswith("g.us") else "dm"
            res.chats.append(
                Chat(
                    platform=PLATFORM,
                    account=account,
                    chat_id=r["chat_jid"],
                    title=r["subject"],
                    kind=kind,
                    source_path=source_path,
                )
            )

        # Messages
        for r in con.execute(
            """
            SELECT m._id AS rid, m.key_id AS key_id, m.from_me AS from_me,
                   m.timestamp AS ts, m.message_type AS mtype, m.text_data AS body,
                   cj.raw_string AS chat_jid, cj.server AS server,
                   c.subject AS subject, sj.raw_string AS sender_jid
            FROM message m
            JOIN chat c ON c._id = m.chat_row_id
            JOIN jid cj ON cj._id = c.jid_row_id
            LEFT JOIN jid sj ON sj._id = m.sender_jid_row_id
            """
        ):
            if not r["key_id"]:
                continue  # msg_id is the platform id; never invent one
            from_me = 1 if r["from_me"] else 0
            if r["sender_jid"]:
                sender_id = r["sender_jid"]
            elif from_me:
                sender_id = None  # the owner's own account
            else:
                sender_id = r["chat_jid"]  # 1:1 incoming: peer is the chat jid
            deleted = r["ts"] if r["rid"] in revoked else None
            res.messages.append(
                Message(
                    platform=PLATFORM,
                    account=account,
                    msg_id=str(r["key_id"]),
                    chat_id=r["chat_jid"],
                    chat_title=r["subject"],
                    sender_id=sender_id,
                    sender_name=None,  # names resolved via contacts, not guessed here
                    ts_utc=r["ts"],
                    body=r["body"],
                    kind=MSG_KIND.get(r["mtype"], "other"),
                    from_me=from_me,
                    deleted_at_source=deleted,
                    source_path=source_path,
                )
            )
        return res
    finally:
        con.close()


def parse_wa_contacts(path: str, account: str, source_path: str) -> ParseResult:
    res = ParseResult()
    con = open_ro(path)
    try:
        try:
            verify_map(con, WA_CONTACTS_MAP)
        except DriftError as e:
            log_drift(source_path, f"{WA_CONTACTS_MAP.name}: {e}")
            return res
        for r in con.execute(
            "SELECT jid, display_name, number FROM wa_contacts WHERE jid IS NOT NULL"
        ):
            res.contacts.append(
                Contact(
                    platform=PLATFORM,
                    account=account,
                    contact_id=r["jid"],
                    display_name=r["display_name"],
                    number=r["number"],
                    source_path=source_path,
                )
            )
        return res
    finally:
        con.close()
