"""SMS parser: mmssms.db `sms` table -> messages (AOSP telephony contract).

The `sms` table is the stable AOSP provider schema:

  _id        row id (the platform's message id -> msg_id)
  thread_id  conversation id (-> chat_id)
  address    the other party's number (sender for inbox, recipient for sent)
  date       epoch-ms the message was received/sent
  body       the text
  type       1 inbox (received), 2 sent, 3 draft, 4 outbox, 5 failed, 6 queued

from_me = 1 when type == 2 (sent). platform = "sms", account = "sms".

MMS (image/group) lives in separate tables (`pdu`, `part`) and is out of scope for
this parser; only the `sms` table is mapped here.
"""
from __future__ import annotations

from unified import Chat, Message, ParseResult

from .base import DriftError, SourceMap, log_drift, open_ro, plausible_ms, verify_map

PLATFORM = "sms"
ACCOUNT = "sms"

SMS_MAP = SourceMap(
    name="sms.mmssms",
    required={"sms": ["_id", "thread_id", "address", "date", "body", "type"]},
)

# AOSP Telephony Sms type codes.
SENT_TYPES = {2, 4, 5, 6}  # sent / outbox / failed / queued are outgoing


def parse_mmssms(path: str, source_path: str) -> ParseResult:
    res = ParseResult()
    con = open_ro(path)
    try:
        try:
            verify_map(con, SMS_MAP)
        except DriftError as e:
            log_drift(source_path, f"{SMS_MAP.name}: {e}")
            return res

        sample = con.execute(
            "SELECT date FROM sms WHERE date IS NOT NULL ORDER BY _id LIMIT 1"
        ).fetchone()
        if sample is not None and not plausible_ms(sample[0]):
            log_drift(source_path, f"{SMS_MAP.name}: sample sms.date {sample[0]} implausible")
            return res

        threads: set[str] = set()
        for r in con.execute(
            "SELECT _id, thread_id, address, date, body, type FROM sms"
        ):
            from_me = 1 if r["type"] in SENT_TYPES else 0
            chat_id = str(r["thread_id"]) if r["thread_id"] is not None else None
            if chat_id and chat_id not in threads:
                threads.add(chat_id)
                res.chats.append(
                    Chat(
                        platform=PLATFORM,
                        account=ACCOUNT,
                        chat_id=chat_id,
                        title=r["address"],
                        kind="dm",
                        source_path=source_path,
                    )
                )
            res.messages.append(
                Message(
                    platform=PLATFORM,
                    account=ACCOUNT,
                    msg_id=str(r["_id"]),
                    chat_id=chat_id,
                    chat_title=r["address"],
                    sender_id=None if from_me else r["address"],
                    sender_name=None,
                    ts_utc=r["date"],
                    body=r["body"],
                    kind="text",
                    from_me=from_me,
                    deleted_at_source=None,
                    source_path=source_path,
                )
            )
        return res
    finally:
        con.close()
