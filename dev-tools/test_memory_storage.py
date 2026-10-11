"""F04/F05 regression: isolated memory files, interrupted writes and world ownership."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import _paths

_paths.require_astrbot("test_memory_storage")
memory = _paths.plugin_module("memory")
MemoryEntry, MemoryStore = memory.MemoryEntry, memory.MemoryStore


def row(text="known memory", **fields):
    return {"kind": "place", "text": text, "at": 100.0, **fields}


def document(rows):
    return json.dumps({"version": 1, "entries": rows}, ensure_ascii=False).encode("utf-8")


class MemoryStorageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="astrcraft-memory-")
        self.addCleanup(self.temporary.cleanup)
        self.folder = Path(self.temporary.name)
        self.path = self.folder / "memory.json"
        self.backup = self.folder / "memory.json.bak"

    def assert_valid_file(self, path):
        entries, invalid = MemoryStore._decode(path.read_bytes())
        self.assertEqual(invalid, [])
        return entries

    def assert_preserved(self, raw, path=None):
        path = path or self.path
        preserved = list(self.folder.glob(f"{path.name}.corrupt-*"))
        self.assertTrue(any(item.read_bytes() == raw for item in preserved), "original bytes preserved")

    def assert_no_temporary_files(self):
        self.assertEqual(list(self.folder.glob(".*.tmp")), [])

    def test_legacy_numbers_and_missing_fields(self):
        old = row("old coordinates (10,64,10)", at="1700000000", weight="4.5", count="3")
        self.path.write_bytes(document([old]))
        store = MemoryStore(self.folder)
        entry = store.recent()[0]
        self.assertEqual((entry.at, entry.first_seen, entry.weight, entry.count),
                         (1700000000.0, 1700000000.0, 4.5, 3))
        self.assertEqual(entry.evidence, [old["text"]])
        self.assertEqual(MemoryEntry.from_json(row(count=0, first_seen=None)).count, 1)
        self.assertEqual(MemoryEntry.from_json(row(count=None)).count, 1)
        self.assertEqual(MemoryEntry.from_json(row(count="2.0", first_seen="50")).first_seen, 50)
        self.assertEqual(MemoryEntry.from_json(row(count="9007199254740993")).count, 9007199254740993)
        self.assertEqual(MemoryEntry.from_json(row(count=str(10**400))).count, 10**400)
        store.save(force=True)
        self.assertEqual(MemoryStore(self.folder).recent()[0].count, 3)

    def test_bad_rows_salvage_good_records_and_preserve_raw_file(self):
        bad = [
            row(at="broken"), row(at="NaN"), row(weight="Infinity"), row(at=True),
            row(first_seen=False), row(count=-2), row(count=1.5), row(tags="tag"), row(at=float("nan")),
            row(evidence=["valid", 4]), row(context=[]), row(count="9007199254740993.1"), None,
        ]
        raw = document([row("first valid"), *bad, row("last valid")])
        self.path.write_bytes(raw)
        store = MemoryStore(self.folder)
        self.assertEqual({entry.text for entry in store.recent()}, {"first valid", "last valid"})
        self.assertFalse(store._write_protected)
        self.assert_preserved(raw)
        store.remember("social", "new valid")
        store.save(force=True)
        self.assertFalse(store._dirty)
        self.assertEqual(len(self.assert_valid_file(self.path)), 3)
        self.assertEqual(len(self.assert_valid_file(self.backup)), 3)
        self.assertEqual(len(MemoryStore(self.folder).recent()), 3)
        self.assert_preserved(raw)

    def test_unencodable_rows_are_isolated_before_later_saves(self):
        bad = [
            row("bad text \ud800"), row(kind="bad kind \udfff"),
            row(tags=["bad tag \ud800"]), row(evidence=["bad evidence \udfff"]),
            row(context={"note": "bad context \ud800"}), row(context={"\ud800": "bad key"}),
        ]
        # JSON escapes can carry lone surrogates even though writing them as UTF-8 fails.
        raw = json.dumps({"version": 1, "entries": [row("valid 😺"), *bad]},
                         ensure_ascii=True).encode("utf-8")
        self.path.write_bytes(raw)
        store = MemoryStore(self.folder)
        self.assertEqual([entry.text for entry in store.recent()], ["valid 😺"])
        self.assert_preserved(raw)
        self.assertIsNotNone(store.remember("social", "new after salvage"))
        store.save(force=True)
        self.assertFalse(store._dirty)
        self.assertEqual({entry.text for entry in MemoryStore(self.folder).recent()},
                         {"valid 😺", "new after salvage"})
        self.assertEqual(len(self.assert_valid_file(self.path)), 2)
        self.assertEqual(len(self.assert_valid_file(self.backup)), 2)

    def test_world_ownership_requires_strings_and_rejects_bad_remember_before_mutation(self):
        invalid_values = [42, 2.5, True, ["A", 25565], {"host": "A"}]
        bad = [row(context={key: value}) for key in ("server", "dimension")
               for value in invalid_values]
        raw = document([row("valid unknown"), row("valid world", context={"server": "A", "dimension": "overworld"}), *bad])
        self.path.write_bytes(raw)
        store = MemoryStore(self.folder)
        self.assertEqual({entry.text for entry in store.recent()}, {"valid unknown", "valid world"})
        self.assert_preserved(raw)
        store.save(force=True)
        self.assertFalse(store._dirty)
        previous = [entry.to_json() for entry in store.recent()]
        for key in ("server", "dimension"):
            for value in [*invalid_values, ("A", 25565), "bad \ud800"]:
                with self.subTest(key=key, value=value):
                    self.assertIsNone(store.remember("place", "valid world", context={key: value}, dedupe_window=0))
                    self.assertEqual([entry.to_json() for entry in store.recent()], previous)
                    self.assertFalse(store._dirty)
        store.save(force=True)
        self.assertEqual([entry.to_json() for entry in MemoryStore(self.folder).recent()], previous)

    def test_unencodable_new_records_cannot_block_a_valid_store(self):
        store = MemoryStore(self.folder)
        store.remember("place", "supply cache (10,64,10)", context={"server": "A"})
        store.save()
        previous = store.recent()[0].to_json()
        for kwargs in ({"text": "supply cache (900,64,900) \ud800"},
                       {"text": "supply cache (900,64,900)", "tags": ["bad \ud800"]}):
            self.assertIsNone(store.remember("place", **kwargs, context={"server": "A"}, dedupe_window=0))
            self.assertEqual(store.recent()[0].to_json(), previous)
            self.assertFalse(store._dirty)
        store.remember("social", "new valid record")
        store.save()
        self.assertFalse(store._dirty)
        self.assertEqual(len(MemoryStore(self.folder).recent()), 2)

    def test_empty_valid_store_is_writable(self):
        self.path.write_bytes(document([]))
        store = MemoryStore(self.folder)
        self.assertFalse(store._write_protected)
        store.save(force=True)
        self.assertEqual(self.assert_valid_file(self.path), [])
        self.assertEqual(self.assert_valid_file(self.backup), [])

    def test_unrecoverable_files_are_protected_even_for_force(self):
        cases = [b'{"entries":[', b'[]', b'{"entries":{}}', b'\xff\xfe',
                 document([row(at="broken")])]
        for index, raw in enumerate(cases):
            with self.subTest(raw=raw), tempfile.TemporaryDirectory(dir=self.folder) as folder:
                path = Path(folder) / "memory.json"
                path.write_bytes(raw)
                store = MemoryStore(Path(folder))
                self.assertTrue(store._write_protected)
                store.remember("social", f"new memory {index}")
                store.save(force=True)
                self.assertEqual(path.read_bytes(), raw)
                self.assertFalse(path.with_name("memory.json.bak").exists())
                self.assertTrue(store._dirty)
                self.assertTrue(any(item.read_bytes() == raw for item in Path(folder).glob("*.corrupt-*")))
                self.assertTrue(MemoryStore(Path(folder))._write_protected)

    def test_bad_main_and_bad_backup_both_remain_preserved_and_protected(self):
        main_raw, backup_raw = b'{"entries":[', document([row(at="broken")])
        self.path.write_bytes(main_raw)
        self.backup.write_bytes(backup_raw)
        store = MemoryStore(self.folder)
        store.remember("social", "cannot replace a lost library")
        store.save(force=True)
        self.assertTrue(store._write_protected)
        self.assertEqual(self.path.read_bytes(), main_raw)
        self.assertEqual(self.backup.read_bytes(), backup_raw)
        self.assert_preserved(main_raw)
        self.assert_preserved(backup_raw, self.backup)

    def test_quarantine_failure_blocks_partial_salvage_and_backup_recovery(self):
        original_write = MemoryStore._atomic_write
        for partial in (True, False):
            with self.subTest(partial=partial), tempfile.TemporaryDirectory(dir=self.folder) as folder:
                root = Path(folder)
                path, backup = root / "memory.json", root / "memory.json.bak"
                raw = document([row("salvaged"), row(at="broken")]) if partial else b'{"entries":['
                backup_raw = document([row("backup record")])
                path.write_bytes(raw)
                backup.write_bytes(backup_raw)

                def fail_quarantine(target, data):
                    if ".corrupt-" in target.name:
                        raise OSError("quarantine unavailable")
                    return original_write(target, data)

                with patch.object(MemoryStore, "_atomic_write", side_effect=fail_quarantine):
                    store = MemoryStore(root)
                self.assertEqual(len(store.recent()), 1)
                self.assertTrue(store._write_protected)
                store.remember("social", "new record")
                store.save(force=True)
                self.assertEqual(path.read_bytes(), raw)
                self.assertEqual(backup.read_bytes(), backup_raw)

    def test_truncated_main_recovers_backup_without_polluting_it(self):
        backup_raw = document([row("backup coordinates (10,64,10)")])
        truncated = b'{"version":1,"entries":[{"kind":"place"'
        self.path.write_bytes(truncated)
        self.backup.write_bytes(backup_raw)
        store = MemoryStore(self.folder)
        self.assertFalse(store._write_protected)
        self.assertTrue(store._dirty)
        self.assertEqual(store.recent()[0].text, "backup coordinates (10,64,10)")
        store.remember("social", "after recovery")
        store.save(force=True)
        self.assertEqual(self.backup.read_bytes(), backup_raw)
        self.assertEqual(len(self.assert_valid_file(self.path)), 2)
        self.assert_preserved(truncated)
        self.assertEqual(len(MemoryStore(self.folder).recent()), 2)

    def test_partial_main_never_replaces_valid_backup_with_bad_bytes(self):
        backup_raw = document([row("previous complete record")])
        partial = document([row("surviving record"), row(at="broken")])
        self.path.write_bytes(partial)
        self.backup.write_bytes(backup_raw)
        store = MemoryStore(self.folder)
        store.save(force=True)
        self.assertEqual(self.backup.read_bytes(), backup_raw)
        self.assertEqual(self.assert_valid_file(self.path)[0].text, "surviving record")
        self.assert_preserved(partial)

    def test_missing_main_recovers_valid_backup_but_rejects_bad_backup(self):
        self.backup.write_bytes(document([row("recovered")]))
        store = MemoryStore(self.folder)
        store.save(force=True)
        self.assertEqual(self.assert_valid_file(self.path)[0].text, "recovered")
        self.path.unlink()
        bad = b'not json'
        self.backup.write_bytes(bad)
        store = MemoryStore(self.folder)
        store.save(force=True)
        self.assertTrue(store._write_protected)
        self.assertFalse(self.path.exists())
        self.assertEqual(self.backup.read_bytes(), bad)
        self.assert_preserved(bad, self.backup)

    def test_atomic_replace_failure_keeps_main_valid_and_dirty_retryable(self):
        store = MemoryStore(self.folder)
        store.remember("social", "first record")
        store.save()
        first_raw = self.path.read_bytes()
        self.assertEqual(self.backup.read_bytes(), first_raw)
        store.remember("social", "second record")
        store.save()
        second_raw = self.path.read_bytes()
        self.assertEqual(self.backup.read_bytes(), first_raw)
        store.remember("social", "third record")
        original_replace = memory.os.replace
        replacements = []

        def fail_main_replace(source, destination):
            self.assertEqual(Path(source).parent, self.folder)
            self.assertEqual(Path(destination).parent, self.folder)
            replacements.append(Path(destination).name)
            if Path(destination) == self.path:
                raise OSError("replace interrupted")
            return original_replace(source, destination)

        with patch.object(memory.os, "replace", side_effect=fail_main_replace):
            store.save()
        self.assertEqual(replacements, ["memory.json.bak", "memory.json"])
        self.assertEqual(self.path.read_bytes(), second_raw)
        self.assertEqual(self.backup.read_bytes(), second_raw)
        self.assertEqual(len(MemoryStore(self.folder).recent()), 2)
        self.assertTrue(store._dirty)
        self.assert_no_temporary_files()
        store.save()
        self.assertFalse(store._dirty)
        self.assertEqual(len(MemoryStore(self.folder).recent()), 3)

    def test_write_flush_and_fsync_failure_cannot_truncate_existing_files(self):
        store = MemoryStore(self.folder)
        store.remember("social", "existing record")
        store.save()
        previous, previous_backup = self.path.read_bytes(), self.backup.read_bytes()
        original_fdopen = memory.os.fdopen

        class InterruptedStream:
            def __init__(self, stream, stage):
                self.stream, self.stage = stream, stage

            def __enter__(self):
                self.stream.__enter__()
                return self

            def __exit__(self, *args):
                return self.stream.__exit__(*args)

            def write(self, raw):
                if self.stage == "write":
                    self.stream.write(raw[:10])
                    raise OSError("partial temporary write")
                if self.stage == "short write":
                    return self.stream.write(raw[:10])
                return self.stream.write(raw)

            def flush(self):
                if self.stage == "flush":
                    raise OSError("temporary flush failed")
                return self.stream.flush()

            def fileno(self):
                return self.stream.fileno()

        for stage in ("write", "short write", "flush", "fsync"):
            with self.subTest(stage=stage):
                store.remember("social", f"pending {stage}")
                if stage == "fsync":
                    injected = patch.object(memory.os, "fsync", side_effect=OSError("fsync failed"))
                else:
                    injected = patch.object(memory.os, "fdopen", side_effect=lambda *a, **kw:
                                            InterruptedStream(original_fdopen(*a, **kw), stage))
                with injected:
                    store.save()
                self.assertEqual(self.path.read_bytes(), previous)
                self.assertEqual(self.backup.read_bytes(), previous_backup)
                self.assertTrue(store._dirty)
                self.assert_no_temporary_files()
        store.save()
        self.assertFalse(store._dirty)
        self.assertEqual(len(MemoryStore(self.folder).recent()), 5)

    def test_invalid_in_memory_record_cannot_contaminate_backup(self):
        store = MemoryStore(self.folder)
        store.remember("social", "existing record")
        store.save()
        previous, previous_backup = self.path.read_bytes(), self.backup.read_bytes()
        store._entries.append(MemoryEntry("place", "invalid", at=float("nan")))
        store._dirty = True
        store.save(force=True)
        self.assertEqual(self.path.read_bytes(), previous)
        self.assertEqual(self.backup.read_bytes(), previous_backup)
        self.assertTrue(store._dirty)

    def test_all_dedupe_paths_use_server_and_dimension(self):
        contexts = [
            {"server": "A", "dimension": "overworld"},
            {"server": "B", "dimension": "overworld"},
            {"server": "A", "dimension": "the_nether"},
            {}, {"server": "A"}, {"dimension": "overworld"},
        ]
        store = MemoryStore(self.folder)
        original = "supply cache (10,64,10)"
        for context in contexts:
            self.assertIsNotNone(store.remember("place", original, context=context))
        self.assertEqual(len(store.recent()), len(contexts), "exact dedupe cannot cross worlds")
        for context in contexts:
            self.assertIsNone(store.remember("place", original, context=context))
        for index, context in enumerate(contexts):
            changed = f"supply cache ({100 + index},64,{100 + index})"
            entry = store.remember("place", changed, context=context, dedupe_window=0)
            self.assertEqual(entry.count, 2)
            self.assertEqual(entry.context, context)
            self.assertEqual(entry.text, original)
            self.assertEqual(entry.evidence, [original, changed])
        store.save()
        reloaded = MemoryStore(self.folder)
        self.assertEqual(len(reloaded.recent()), len(contexts))
        for index, context in enumerate(contexts):
            entry = next(entry for entry in reloaded.recent() if entry.context == context)
            self.assertEqual(entry.count, 2)
            self.assertEqual(entry.evidence, [original, f"supply cache ({100 + index},64,{100 + index})"])
        for context in contexts[:3]:
            hits = reloaded.recall("supply cache", context=context, limit=20)
            self.assertTrue(any(entry.context == context for entry in hits))
            self.assertFalse(any(entry.context in contexts[:3] and entry.context != context for entry in hits))

    def test_same_world_merge_keeps_context_for_representative_text(self):
        store = MemoryStore(self.folder)
        first_context = {"server": "A", "dimension": "overworld", "position": {"x": 10, "y": 64, "z": 10}}
        second_context = {"server": "A", "dimension": "overworld", "position": {"x": 900, "y": 64, "z": 900}}
        original, changed = "supply cache (10,64,10)", "supply cache (900,64,900)"
        first = store.remember("place", original, context=first_context)
        first_context["position"]["x"] = 11
        self.assertEqual(first.context["position"], {"x": 10, "y": 64, "z": 10}, "remember stores a snapshot")
        entry = store.remember("place", changed, context=second_context, dedupe_window=0)
        self.assertEqual(entry.text, original)
        self.assertEqual(entry.context, {"server": "A", "dimension": "overworld", "position": {"x": 10, "y": 64, "z": 10}})
        self.assertEqual(entry.evidence, [original, changed])
        self.assertEqual(entry.count, 2)
        before = entry.to_json()
        store.save()
        self.assertFalse(store._dirty)
        self.assertEqual(MemoryStore(self.folder).recent()[0].to_json(), before)

    def test_load_merge_does_not_borrow_context_from_another_text(self):
        original, changed = "supply cache (10,64,10)", "supply cache (900,64,900)"
        self.path.write_bytes(document([
            row(original), row(changed, context={"position": {"x": 900, "y": 64, "z": 900}}),
        ]))
        store = MemoryStore(self.folder)
        entry = store.recent()[0]
        self.assertEqual(entry.text, original)
        self.assertEqual(entry.context, {})
        self.assertEqual(entry.evidence, [original, changed])
        self.assertEqual(entry.count, 2)
        before = entry.to_json()
        store.save()
        self.assertFalse(store._dirty)
        self.assertEqual(MemoryStore(self.folder).recent()[0].to_json(), before)

    def test_load_and_prune_consolidation_keep_unknown_and_known_scopes_separate(self):
        contexts = [{}, {"server": "A", "dimension": "overworld"},
                    {"server": "B", "dimension": "overworld"},
                    {"server": "A", "dimension": "the_nether"}]
        rows = [row(f"supply cache ({index},64,{index})", context=context)
                for context in contexts for index in (10, 900)]
        self.path.write_bytes(document(rows))
        store = MemoryStore(self.folder)
        self.assertEqual(len(store.recent()), 4)
        for entry in store.recent():
            self.assertEqual(entry.count, 2)
            self.assertEqual(entry.evidence, ["supply cache (10,64,10)", "supply cache (900,64,900)"])
        store._entries = [MemoryEntry.from_json(item) for item in rows]
        store._dirty = True
        store.save()
        reloaded = MemoryStore(self.folder)
        self.assertEqual(len(reloaded.recent()), 4)
        self.assertTrue(all(entry.count == 2 for entry in reloaded.recent()))
        self.assertEqual({memory._world_key(entry.context) for entry in reloaded.recent()},
                         {memory._world_key(context) for context in contexts})


if __name__ == "__main__":
    unittest.main(verbosity=2)
