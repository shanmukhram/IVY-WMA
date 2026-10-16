"""Build synthetic SQLite fixtures that match the DOCUMENTED schemas the parsers
pin, plus a staging `out/` dir with a manifest.tsv in stack.sh's format.

No real personal data: all values here are invented test strings. The fixtures
exercise WhatsApp (two accounts), SMS, contacts2 (contacts + calls), and the
unmapped LINE/Telegram stubs. `build_drift` makes a mmssms.db with a renamed
column to exercise the red-on-drift skip path.
"""
from __future__ import annotations

import hashlib
import os
import sqlite3

T = 1_700_000_000_000  # 2023-11-14, a plausible epoch-ms timestamp


def _new_db(path: str) -> sqlite3.Connection:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path):
        os.remove(path)
    return sqlite3.connect(path)


# --- WhatsApp msgstore (modern normalized schema) ------------------------

def _whatsapp_msgstore(path: str, account_tag: str) -> None:
    con = _new_db(path)
    con.executescript(
        """
        CREATE TABLE jid (_id INTEGER PRIMARY KEY, user TEXT, server TEXT,
                          agent INTEGER, device INTEGER, type INTEGER, raw_string TEXT);
        CREATE TABLE chat (_id INTEGER PRIMARY KEY, jid_row_id INTEGER, subject TEXT,
                           created_timestamp INTEGER);
        CREATE TABLE message (_id INTEGER PRIMARY KEY, chat_row_id INTEGER,
                              from_me INTEGER, key_id TEXT, sender_jid_row_id INTEGER,
                              status INTEGER, timestamp INTEGER, message_type INTEGER,
                              text_data TEXT);
        CREATE TABLE message_revoked (_id INTEGER PRIMARY KEY, message_row_id INTEGER,
                                      revoked_key_id TEXT);
        """
    )
    con.executemany(
        "INSERT INTO jid (_id,user,server,agent,device,type,raw_string) VALUES (?,?,?,?,?,?,?)",
        [
            (1, "15551230001", "s.whatsapp.net", 0, 0, 0, "15551230001@s.whatsapp.net"),
            (2, "120363001", "g.us", 0, 0, 1, "120363001@g.us"),
            (3, "15559990002", "s.whatsapp.net", 0, 0, 0, "15559990002@s.whatsapp.net"),
        ],
    )
    con.executemany(
        "INSERT INTO chat (_id,jid_row_id,subject,created_timestamp) VALUES (?,?,?,?)",
        [(10, 1, None, T), (11, 2, "Project Group", T)],
    )
    pfx = account_tag.upper()
    con.executemany(
        "INSERT INTO message (_id,chat_row_id,from_me,key_id,sender_jid_row_id,status,"
        "timestamp,message_type,text_data) VALUES (?,?,?,?,?,?,?,?,?)",
        [
            (100, 10, 0, f"{pfx}MID001", None, 0, T, 0, "hello from whatsapp"),
            (101, 10, 1, f"{pfx}MID002", None, 5, T + 1000, 0, "reply from me"),
            (102, 11, 0, f"{pfx}MID003", 3, 0, T + 2000, 1, None),  # image in group
            (103, 10, 0, f"{pfx}MID004", None, 0, T + 3000, 0, "this will be deleted"),
        ],
    )
    con.execute(
        "INSERT INTO message_revoked (_id,message_row_id,revoked_key_id) VALUES (1,103,?)",
        (f"{pfx}MID004",),
    )
    con.commit()
    con.close()


def _whatsapp_wa(path: str) -> None:
    con = _new_db(path)
    con.executescript(
        """
        CREATE TABLE wa_contacts (_id INTEGER PRIMARY KEY, jid TEXT, display_name TEXT,
                                  number TEXT, wa_name TEXT, is_whatsapp_user INTEGER);
        """
    )
    con.executemany(
        "INSERT INTO wa_contacts (jid,display_name,number,wa_name,is_whatsapp_user) "
        "VALUES (?,?,?,?,?)",
        [
            ("15551230001@s.whatsapp.net", "Alice Example", "+1 555 123 0001", "Alice", 1),
            ("15559990002@s.whatsapp.net", "Bob Example", "+1 555 999 0002", "Bob", 1),
        ],
    )
    con.commit()
    con.close()


# --- SMS mmssms.db -------------------------------------------------------

def _mmssms(path: str, body_col: str = "body") -> None:
    """Build mmssms.db. body_col lets a drift fixture rename the `body` column."""
    con = _new_db(path)
    con.execute(
        f"""
        CREATE TABLE sms (_id INTEGER PRIMARY KEY, thread_id INTEGER, address TEXT,
                          person INTEGER, date INTEGER, date_sent INTEGER, read INTEGER,
                          status INTEGER, type INTEGER, subject TEXT, {body_col} TEXT,
                          seen INTEGER);
        """
    )
    con.executemany(
        f"INSERT INTO sms (_id,thread_id,address,date,type,{body_col}) VALUES (?,?,?,?,?,?)",
        [
            (1, 5, "+15551112222", T, 1, "sms hello world"),
            (2, 5, "+15551112222", T + 1000, 2, "sms reply from me"),
            (3, 7, "+15553334444", T + 2000, 1, "another sms thread"),
        ],
    )
    con.commit()
    con.close()


# --- contacts2.db (contacts + calls) -------------------------------------

def _contacts2(path: str) -> None:
    con = _new_db(path)
    con.executescript(
        """
        CREATE TABLE mimetypes (_id INTEGER PRIMARY KEY, mimetype TEXT);
        CREATE TABLE raw_contacts (_id INTEGER PRIMARY KEY, contact_id INTEGER,
                                   display_name TEXT, display_name_alt TEXT);
        CREATE TABLE data (_id INTEGER PRIMARY KEY, raw_contact_id INTEGER,
                           mimetype_id INTEGER, data1 TEXT);
        CREATE TABLE calls (_id INTEGER PRIMARY KEY, number TEXT, date INTEGER,
                            duration INTEGER, type INTEGER, name TEXT,
                            geocoded_location TEXT);
        """
    )
    con.executemany(
        "INSERT INTO mimetypes (_id,mimetype) VALUES (?,?)",
        [(1, "vnd.android.cursor.item/phone_v2"), (2, "vnd.android.cursor.item/email_v2")],
    )
    con.executemany(
        "INSERT INTO raw_contacts (_id,contact_id,display_name) VALUES (?,?,?)",
        [(1, 1, "Carol Example"), (2, 2, "Dave Example")],
    )
    con.executemany(
        "INSERT INTO data (raw_contact_id,mimetype_id,data1) VALUES (?,?,?)",
        [
            (1, 1, "+1 555 333 4444"),
            (1, 2, "carol@example.com"),
            (2, 1, "+1 555 555 6666"),
        ],
    )
    con.executemany(
        "INSERT INTO calls (_id,number,date,duration,type,name) VALUES (?,?,?,?,?,?)",
        [
            (1, "+15553334444", T, 42, 1, "Carol Example"),       # incoming
            (2, "+15557778888", T + 1000, 0, 3, None),            # missed
            (3, "+15553334444", T + 2000, 125, 2, "Carol Example"),  # outgoing
        ],
    )
    con.commit()
    con.close()


def _line_naver(path: str) -> None:
    """A stand-in for the SQLCipher-encrypted LINE store: random (non-SQLite) header."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(os.urandom(4096))  # no "SQLite format 3" magic -> classified encrypted


def _telegram_cache4(path: str) -> None:
    """A plain-SQLite cache4.db with a Telegram-ish table but no mappable columns
    (messages are TL blobs). The stub must still skip: map is verified=false."""
    con = _new_db(path)
    con.executescript(
        """
        CREATE TABLE messages_v2 (mid INTEGER, uid INTEGER, data BLOB, date INTEGER);
        CREATE TABLE dialogs (did INTEGER, date INTEGER);
        """
    )
    con.execute("INSERT INTO messages_v2 (mid,uid,data,date) VALUES (1,2,?,?)",
                (os.urandom(64), T))
    con.commit()
    con.close()


# --- staging dir + manifest ---------------------------------------------

def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _classify(path: str) -> str:
    with open(path, "rb") as f:
        head = f.read(15)
    return "sqlite-plain" if head == b"SQLite format 3" else "encrypted-or-other"


def _write_manifest(out_dir: str, rows: list[tuple[str, str]]) -> None:
    """rows: list of (device_source_path, staged_relpath)."""
    lines = ["source\tstaged\tbytes\tsha256\ttype"]
    for source, staged in rows:
        p = os.path.join(out_dir, staged.replace("/", os.sep))
        lines.append(
            "\t".join(
                [source, staged, str(os.path.getsize(p)), _sha256(p), _classify(p)]
            )
        )
    with open(os.path.join(out_dir, "manifest.tsv"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def build(out_dir: str) -> str:
    """Build the full happy-path staging dir. Returns out_dir."""
    os.makedirs(out_dir, exist_ok=True)
    rows = []

    def db(relpath, device_path, builder, *a):
        full = os.path.join(out_dir, relpath.replace("/", os.sep))
        builder(full, *a)
        rows.append((device_path, relpath))

    db("com.whatsapp/databases/msgstore.db",
       "/data/data/com.whatsapp/databases/msgstore.db", _whatsapp_msgstore, "wa")
    db("com.whatsapp/databases/wa.db",
       "/data/data/com.whatsapp/databases/wa.db", _whatsapp_wa)
    db("com.whatsapp.w4b/databases/msgstore.db",
       "/data/data/com.whatsapp.w4b/databases/msgstore.db", _whatsapp_msgstore, "w4b")
    db("com.whatsapp.w4b/databases/wa.db",
       "/data/data/com.whatsapp.w4b/databases/wa.db", _whatsapp_wa)
    db("com.android.providers.telephony/databases/mmssms.db",
       "/data/data/com.android.providers.telephony/databases/mmssms.db", _mmssms)
    db("com.android.providers.contacts/databases/contacts2.db",
       "/data/data/com.android.providers.contacts/databases/contacts2.db", _contacts2)
    db("jp.naver.line.android/databases/naver_line",
       "/data/data/jp.naver.line.android/databases/naver_line", _line_naver)
    db("org.telegram.messenger/files/cache4.db",
       "/data/data/org.telegram.messenger/files/cache4.db", _telegram_cache4)

    _write_manifest(out_dir, rows)
    return out_dir


def build_drift(out_dir: str) -> str:
    """Staging dir whose mmssms.db has `body` renamed to `content` (schema drift)."""
    os.makedirs(out_dir, exist_ok=True)
    rel = "com.android.providers.telephony/databases/mmssms.db"
    _mmssms(os.path.join(out_dir, rel.replace("/", os.sep)), body_col="content")
    _write_manifest(
        out_dir,
        [("/data/data/com.android.providers.telephony/databases/mmssms.db", rel)],
    )
    return out_dir


# --- LINE media exports (external, plaintext) ----------------------------
#
# Synthetic stand-ins for the owner's exported LINE files. All bytes are invented
# test content: a header that a real media sniffer recognises, plus unique padding
# so distinct files hash distinctly (except where we deliberately reuse bytes to
# exercise content-addressed dedup).

import zipfile as _zipfile  # noqa: E402


def _jpeg(tag: bytes = b"") -> bytes:
    return b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00" + tag + b"\xff\xd9"


def _png(tag: bytes = b"") -> bytes:
    return b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR" + tag + b"\x00\x00\x00\x00IEND\xaeB`\x82"


def _pdf(tag: bytes = b"") -> bytes:
    return b"%PDF-1.4\n1 0 obj<<>>endobj\n" + tag + b"\n%%EOF\n"


def _mp4_aac(tag: bytes = b"") -> bytes:
    return b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + tag


# Shared JPEG used by two different messages -> must dedup to ONE archive object.
SHARED_JPEG = _jpeg(b"shared-image-bytes")


def _write(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


# chatIds are opaque hashes (u=1:1, c=group); no personal names anywhere.
CHAT_DM = "u00000000000000000000000000000dead"
CHAT_GROUP = "c00000000000000000000000000000beef"


def build_line_ext(base_dir: str) -> str:
    """A synthetic line_ext chat-media tree under <base_dir>/line_ext/.

    Returns base_dir (the path to hand to the ingester as a directory). Contents:
      - two chats, one DM + one group
      - a JPEG, a plaintext thumbnail, a PDF, an AAC voice note (keyed by msg id)
      - a `<msg>-hmac` and `<msg>-hash` integrity sidecar (counted + skipped)
      - one bogus non-media file (skipped red-on-drift)
      - the SHARED_JPEG reused across two messages (archive dedup)
    """
    root = os.path.join(base_dir, "line_ext", "files", "chats")

    def msg(chat, name, data):
        _write(os.path.join(root, chat, "messages", name), data)

    # DM chat: full image + thumbnail + pdf + sidecars + bogus, all msg 100/101/102
    msg(CHAT_DM, "100.jpg", SHARED_JPEG)
    msg(CHAT_DM, "100.thumb", _jpeg(b"thumb-100"))  # plain JPEG thumbnail
    msg(CHAT_DM, "100-hmac", os.urandom(32))        # integrity sidecar
    msg(CHAT_DM, "100-hash", os.urandom(32))        # integrity sidecar
    msg(CHAT_DM, "101.pdf", _pdf(b"doc-101"))
    msg(CHAT_DM, "102.bin", b"NOTMEDIA\x00garbage-not-a-real-file")  # bogus

    # Group chat: the SAME jpeg bytes again (dedup) + a voice note
    msg(CHAT_GROUP, "200.jpg", SHARED_JPEG)
    msg(CHAT_GROUP, "voice_201.aac", _mp4_aac(b"voice-201"))

    return base_dir


def build_line_keep(base_dir: str) -> str:
    """A synthetic line_export Keep tree under <base_dir>/line_export/ (flat)."""
    root = os.path.join(base_dir, "line_export")
    _write(os.path.join(root, "brief.pdf"), _pdf(b"keep-brief"))
    _write(os.path.join(root, "poster.png"), _png(b"keep-poster"))
    return base_dir


def zip_tree(base_dir: str, zip_path: str) -> str:
    """Zip everything under base_dir into zip_path (arcnames relative to base_dir,
    so a line_ext/line_export top-level folder is preserved). Returns zip_path."""
    with _zipfile.ZipFile(zip_path, "w", _zipfile.ZIP_DEFLATED) as z:
        for dp, _dn, fn in os.walk(base_dir):
            for f in fn:
                full = os.path.join(dp, f)
                arc = os.path.relpath(full, base_dir).replace(os.sep, "/")
                z.write(full, arc)
    return zip_path


if __name__ == "__main__":
    import sys

    target = sys.argv[1] if len(sys.argv) > 1 else "./out"
    build(target)
    print(f"fixtures written to {target}")
