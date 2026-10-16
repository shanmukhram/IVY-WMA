#!/usr/bin/env python3
"""Fixture tests for the IVY host pipeline. No network, no device.

Run:  py -3 android/host/tests/test_pipeline.py

Covers: WhatsApp/SMS/contacts/calls parsing -> unified rows; two distinct WhatsApp
accounts; idempotent re-ingest (no dupes); decision-24 delete keeps captured body;
archive encrypt/decrypt round-trip (+ wrong passphrase fails); FTS search hits;
red-on-drift (renamed column -> skip, zero rows, logged reason); LINE/Telegram
stubs skip; and an end-to-end ingest+search over the CLI.
"""
from __future__ import annotations

import io
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr

HOST = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HOST)

import make_fixtures as fx  # noqa: E402  (tests dir is this file's dir)
from archive import Archive  # noqa: E402
from staging import Staging  # noqa: E402
from unified import Message, UnifiedDB  # noqa: E402
from parsers import contacts as p_contacts  # noqa: E402
from parsers import sms as p_sms  # noqa: E402
from parsers import stub as p_stub  # noqa: E402
from parsers import whatsapp as p_wa  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # for make_fixtures

PW = "correct horse battery staple"
MAPS = os.path.join(HOST, "maps")


class WhatsAppTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.out = fx.build(os.path.join(self.tmp, "out"))
        self.st = Staging(self.out)

    def _msgstore(self, pkg):
        e = self.st.find_one(f"{pkg}/databases/msgstore.db")
        self.assertIsNotNone(e)
        return p_wa.parse_msgstore(e.abspath(self.out), "whatsapp", e.source)

    def test_messages_parsed(self):
        r = self._msgstore("com.whatsapp")
        self.assertEqual(len(r.messages), 4)
        self.assertEqual(len(r.chats), 2)
        by_id = {m.msg_id: m for m in r.messages}
        self.assertEqual(by_id["WAMID001"].body, "hello from whatsapp")
        self.assertEqual(by_id["WAMID001"].from_me, 0)
        self.assertEqual(by_id["WAMID002"].from_me, 1)
        self.assertEqual(by_id["WAMID003"].kind, "image")
        # group sender resolved to the sender jid, dm peer to the chat jid
        self.assertEqual(by_id["WAMID003"].sender_id, "15559990002@s.whatsapp.net")
        self.assertEqual(by_id["WAMID001"].sender_id, "15551230001@s.whatsapp.net")

    def test_revoked_marks_deleted_keeps_body(self):
        r = self._msgstore("com.whatsapp")
        m = {m.msg_id: m for m in r.messages}["WAMID004"]
        self.assertIsNotNone(m.deleted_at_source)  # marked deleted-at-source
        self.assertEqual(m.body, "this will be deleted")  # body still captured

    def test_group_vs_dm(self):
        r = self._msgstore("com.whatsapp")
        kinds = {c.chat_id: c.kind for c in r.chats}
        self.assertEqual(kinds["120363001@g.us"], "group")
        self.assertEqual(kinds["15551230001@s.whatsapp.net"], "dm")

    def test_contacts_from_wa_db(self):
        e = self.st.find_one("com.whatsapp/databases/wa.db")
        r = p_wa.parse_wa_contacts(e.abspath(self.out), "whatsapp", e.source)
        self.assertEqual(len(r.contacts), 2)
        self.assertEqual(r.contacts[0].display_name, "Alice Example")

    def test_two_distinct_accounts(self):
        wa = self._msgstore("com.whatsapp")
        e = self.st.find_one("com.whatsapp.w4b/databases/msgstore.db")
        w4b = p_wa.parse_msgstore(e.abspath(self.out), "whatsapp_business", e.source)
        self.assertEqual({m.account for m in wa.messages}, {"whatsapp"})
        self.assertEqual({m.account for m in w4b.messages}, {"whatsapp_business"})
        self.assertTrue(any(m.msg_id == "W4BMID001" for m in w4b.messages))


class SmsContactsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.out = fx.build(os.path.join(self.tmp, "out"))
        self.st = Staging(self.out)

    def test_sms(self):
        e = self.st.find_one("mmssms.db")
        r = p_sms.parse_mmssms(e.abspath(self.out), e.source)
        self.assertEqual(len(r.messages), 3)
        by = {m.msg_id: m for m in r.messages}
        self.assertEqual(by["1"].from_me, 0)
        self.assertEqual(by["2"].from_me, 1)
        self.assertEqual(by["1"].body, "sms hello world")

    def test_contacts_and_calls(self):
        e = self.st.find_one("contacts2.db")
        r = p_contacts.parse_contacts2(e.abspath(self.out), e.source)
        self.assertEqual(len(r.contacts), 2)
        names = {c.display_name: c.number for c in r.contacts}
        self.assertEqual(names["Carol Example"], "+1 555 333 4444")
        self.assertEqual(len(r.calls), 3)
        dirs = {c.call_id: c.direction for c in r.calls}
        self.assertEqual(dirs["1"], "incoming")
        self.assertEqual(dirs["2"], "missed")
        self.assertEqual(dirs["3"], "outgoing")


class UnifiedTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.out = fx.build(os.path.join(self.tmp, "out"))
        self.st = Staging(self.out)

    def _ingest_all(self, udb):
        for pkg, acct in (("com.whatsapp", "whatsapp"), ("com.whatsapp.w4b", "whatsapp_business")):
            e = self.st.find_one(f"{pkg}/databases/msgstore.db")
            udb.ingest(p_wa.parse_msgstore(e.abspath(self.out), acct, e.source))
            w = self.st.find_one(f"{pkg}/databases/wa.db")
            udb.ingest(p_wa.parse_wa_contacts(w.abspath(self.out), acct, w.source))
        e = self.st.find_one("mmssms.db")
        udb.ingest(p_sms.parse_mmssms(e.abspath(self.out), e.source))
        e = self.st.find_one("contacts2.db")
        udb.ingest(p_contacts.parse_contacts2(e.abspath(self.out), e.source))

    def test_idempotent_reingest(self):
        udb = UnifiedDB.in_memory()
        self._ingest_all(udb)
        first = udb.counts()
        self._ingest_all(udb)  # re-ingest the identical sources
        second = udb.counts()
        self.assertEqual(first, second, "re-ingest must not duplicate rows")
        # 4 WA + 4 W4B messages + 3 sms = 11
        self.assertEqual(first["messages"], 11)
        udb.close()

    def test_delete_only_marks_keeps_body(self):
        udb = UnifiedDB.in_memory()
        udb.merge_message(
            Message(platform="whatsapp", account="whatsapp", msg_id="X1",
                    body="captured text", ts_utc=fx.T)
        )
        udb.con.commit()
        # A later copy reports it deleted with an empty body.
        udb.merge_message(
            Message(platform="whatsapp", account="whatsapp", msg_id="X1",
                    body="", ts_utc=fx.T, deleted_at_source=fx.T + 5000)
        )
        udb.con.commit()
        row = udb.con.execute(
            "SELECT body, deleted_at_source FROM messages WHERE msg_id='X1'"
        ).fetchone()
        self.assertEqual(row["body"], "captured text")  # never wiped (decision 24)
        self.assertEqual(row["deleted_at_source"], fx.T + 5000)
        self.assertEqual(udb.counts()["messages"], 1)  # still one row
        udb.close()

    def test_fts_search(self):
        udb = UnifiedDB.in_memory()
        self._ingest_all(udb)
        self.assertTrue(any("whatsapp" in (r["body"] or "") for r in udb.search("whatsapp")))
        self.assertTrue(udb.search("sms"))
        self.assertFalse(udb.search("nonexistenttermxyz"))
        udb.close()

    def test_serialize_roundtrip(self):
        udb = UnifiedDB.in_memory()
        self._ingest_all(udb)
        image = udb.serialize()
        udb.close()
        reopened = UnifiedDB.from_bytes(image)
        self.assertEqual(reopened.counts()["messages"], 11)
        self.assertTrue(reopened.search("whatsapp"))  # FTS survives serialize
        reopened.close()


class ArchiveTests(unittest.TestCase):
    def test_roundtrip_and_wrong_passphrase(self):
        root = os.path.join(tempfile.mkdtemp(), "archive")
        arc = Archive.create(root, PW)
        data = os.urandom(5000)
        h = arc.put_bytes(data)
        self.assertEqual(arc.get_bytes(h), data)  # round-trip
        # idempotent put
        self.assertEqual(arc.put_bytes(data), h)
        # reopen with correct passphrase
        arc2 = Archive.open(root, PW)
        self.assertEqual(arc2.get_bytes(h), data)
        # wrong passphrase fails to decrypt
        bad = Archive.open(root, "wrong passphrase")
        with self.assertRaises(Exception):
            bad.get_bytes(h)

    def test_argon2_kdf_used(self):
        root = os.path.join(tempfile.mkdtemp(), "archive")
        arc = Archive.create(root, PW)
        # argon2-cffi is installed here, so the archive must use the PROTOCOL KDF.
        self.assertEqual(arc.kdf.algo, "argon2id")
        self.assertFalse(arc.uses_fallback_kdf())

    def test_named_ref(self):
        root = os.path.join(tempfile.mkdtemp(), "archive")
        arc = Archive.create(root, PW)
        arc.put_ref_bytes("unified.db", b"hello world")
        self.assertEqual(Archive.open(root, PW).get_ref_bytes("unified.db"), b"hello world")


class DriftTests(unittest.TestCase):
    def test_renamed_column_skips_with_reason(self):
        out = fx.build_drift(os.path.join(tempfile.mkdtemp(), "out"))
        st = Staging(out)
        e = st.find_one("mmssms.db")
        buf = io.StringIO()
        with redirect_stderr(buf):
            r = p_sms.parse_mmssms(e.abspath(out), e.source)
        self.assertEqual(len(r.messages), 0)  # zero guessed rows
        log = buf.getvalue()
        self.assertIn("[DRIFT]", log)
        self.assertIn("missing columns", log)
        self.assertIn("body", log)


class StubTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.out = fx.build(os.path.join(self.tmp, "out"))
        self.st = Staging(self.out)

    def test_line_stub_skips_encrypted(self):
        e = self.st.find_one("naver_line")
        buf = io.StringIO()
        with redirect_stderr(buf):
            r = p_stub.parse_with_map(
                e.abspath(self.out), os.path.join(MAPS, "line.map.json"), e.source
            )
        self.assertEqual(len(r.messages), 0)
        log = buf.getvalue()
        self.assertIn("detected as encrypted", log)
        self.assertIn("pending real-schema verification", log)

    def test_telegram_stub_skips_unverified(self):
        e = self.st.find_one("cache4.db")
        buf = io.StringIO()
        with redirect_stderr(buf):
            r = p_stub.parse_with_map(
                e.abspath(self.out), os.path.join(MAPS, "telegram.map.json"), e.source
            )
        self.assertEqual(len(r.messages), 0)
        log = buf.getvalue()
        self.assertIn("detected as plain", log)  # cache4.db IS plain sqlite...
        self.assertIn("pending real-schema verification", log)  # ...but still skipped


class EndToEndTests(unittest.TestCase):
    def test_ingest_then_search_via_cli(self):
        import ivy_host

        tmp = tempfile.mkdtemp()
        out = fx.build(os.path.join(tmp, "out"))
        archive = os.path.join(tmp, "archive")
        os.environ["IVY_PASSPHRASE"] = PW
        try:
            rc = ivy_host.main(["ingest", out, "--archive", archive])
            self.assertEqual(rc, 0)
            # No plaintext unified.db written anywhere under the archive.
            for dirpath, _dirs, files in os.walk(archive):
                for fn in files:
                    self.assertFalse(fn.endswith(".db"),
                                     f"plaintext db leaked: {fn}")
            # Archive is openable and search works end-to-end.
            arc = Archive.open(archive, PW)
            udb = UnifiedDB.from_bytes(arc.get_ref_bytes("unified.db"))
            self.assertEqual(udb.counts()["messages"], 11)
            self.assertTrue(udb.search("whatsapp"))
            udb.close()
            # Re-ingest over the CLI stays idempotent across runs.
            rc = ivy_host.main(["ingest", out, "--archive", archive])
            self.assertEqual(rc, 0)
            arc2 = Archive.open(archive, PW)
            udb2 = UnifiedDB.from_bytes(arc2.get_ref_bytes("unified.db"))
            self.assertEqual(udb2.counts()["messages"], 11)
            udb2.close()
        finally:
            os.environ.pop("IVY_PASSPHRASE", None)


if __name__ == "__main__":
    unittest.main(verbosity=2)
