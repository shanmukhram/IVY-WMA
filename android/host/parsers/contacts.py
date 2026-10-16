"""contacts2.db parser: contacts -> contacts, and the `calls` table -> call records.

Stable AOSP contract (least drift of all the sources). Two independent maps so a
drift in one does not suppress the other:

Contacts (join raw_contacts -> data -> mimetypes):
  raw_contacts._id            contact id (-> contact_id)
  raw_contacts.display_name   name
  data.raw_contact_id      -> raw_contacts._id
  data.mimetype_id         -> mimetypes._id
  data.data1                  the phone number (for the phone_v2 mimetype)
  mimetypes.mimetype          'vnd.android.cursor.item/phone_v2' marks phone rows

Calls (the `calls` table, AOSP CallLog):
  calls._id       call id (-> call_id)
  calls.number    the other party's number
  calls.date      epoch-ms of the call
  calls.duration  seconds
  calls.type      1 incoming, 2 outgoing, 3 missed, 4 voicemail, 5 rejected, 6 blocked
  calls.name      cached contact name (optional column)
"""
from __future__ import annotations

from unified import Call, Contact, ParseResult

from .base import (
    DriftError,
    SourceMap,
    log_drift,
    open_ro,
    plausible_ms,
    table_columns,
    verify_map,
)

CONTACTS_PLATFORM = "contacts"
CALLS_PLATFORM = "calls"
ACCOUNT = "device"

PHONE_MIMETYPE = "vnd.android.cursor.item/phone_v2"

CONTACTS_MAP = SourceMap(
    name="contacts2.contacts",
    required={
        "raw_contacts": ["_id", "display_name"],
        "data": ["raw_contact_id", "mimetype_id", "data1"],
        "mimetypes": ["_id", "mimetype"],
    },
)

CALLS_MAP = SourceMap(
    name="contacts2.calls",
    required={"calls": ["_id", "number", "date", "duration", "type"]},
)

CALL_DIRECTION = {
    1: "incoming",
    2: "outgoing",
    3: "missed",
    4: "voicemail",
    5: "rejected",
    6: "blocked",
}


def parse_contacts2(path: str, source_path: str) -> ParseResult:
    res = ParseResult()
    con = open_ro(path)
    try:
        _parse_contacts(con, res, source_path)
        _parse_calls(con, res, source_path)
        return res
    finally:
        con.close()


def _parse_contacts(con, res: ParseResult, source_path: str) -> None:
    try:
        verify_map(con, CONTACTS_MAP)
    except DriftError as e:
        log_drift(source_path, f"{CONTACTS_MAP.name}: {e}")
        return

    phone_mt = con.execute(
        "SELECT _id FROM mimetypes WHERE mimetype = ?", (PHONE_MIMETYPE,)
    ).fetchone()
    phone_mt_id = phone_mt[0] if phone_mt else -1

    for r in con.execute(
        """
        SELECT rc._id AS rid, rc.display_name AS name,
               (SELECT d.data1 FROM data d
                 WHERE d.raw_contact_id = rc._id AND d.mimetype_id = ?
                 LIMIT 1) AS number
        FROM raw_contacts rc
        """,
        (phone_mt_id,),
    ):
        res.contacts.append(
            Contact(
                platform=CONTACTS_PLATFORM,
                account=ACCOUNT,
                contact_id=str(r["rid"]),
                display_name=r["name"],
                number=r["number"],
                source_path=source_path,
            )
        )


def _parse_calls(con, res: ParseResult, source_path: str) -> None:
    try:
        verify_map(con, CALLS_MAP)
    except DriftError as e:
        log_drift(source_path, f"{CALLS_MAP.name}: {e}")
        return

    sample = con.execute(
        "SELECT date FROM calls WHERE date IS NOT NULL ORDER BY _id LIMIT 1"
    ).fetchone()
    if sample is not None and not plausible_ms(sample[0]):
        log_drift(source_path, f"{CALLS_MAP.name}: sample calls.date {sample[0]} implausible")
        return

    have_name = "name" in table_columns(con, "calls")
    name_col = "name" if have_name else "NULL AS name"
    for r in con.execute(
        f"SELECT _id, number, date, duration, type, {name_col} FROM calls"
    ):
        res.calls.append(
            Call(
                platform=CALLS_PLATFORM,
                account=ACCOUNT,
                call_id=str(r["_id"]),
                number=r["number"],
                contact_name=r["name"],
                ts_utc=r["date"],
                direction=CALL_DIRECTION.get(r["type"], "unknown"),
                duration_s=r["duration"],
                source_path=source_path,
            )
        )
