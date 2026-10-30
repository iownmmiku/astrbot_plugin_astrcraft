"""Engine startup and pipe ownership must stay with the originating process."""
from __future__ import annotations

import asyncio
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _paths
_paths.require_astrbot("test_bridge_lifecycle")
B = _paths.plugin_module("bridge_client")


class FakeProc:
    def __init__(self):
        self.returncode = None
        self.stdin = None
        self.stdout = asyncio.StreamReader()
        self.stderr = asyncio.StreamReader()
        self.waited = False

    async def wait(self):
        self.waited = True
        self.returncode = 0
        self.stdout.feed_eof()
        self.stderr.feed_eof()
        return 0

    def kill(self):
        self.returncode = -9


def ready(proc, pid):
    proc.stdout.feed_data((json.dumps({"method": "notice", "params": {
        "event": "engine.ready", "data": {"version": "test", "pid": pid}}}) + "\n").encode())


class LifecycleTests(unittest.IsolatedAsyncioTestCase):
    def client(self):
        c = B.EngineClient(B.EngineConfig(_paths.ENGINE_DIR))
        self.addAsyncCleanup(c.stop)
        return c

    async def test_concurrent_start_waits_for_same_ready(self):
        c, proc = self.client(), FakeProc()
        spawned = asyncio.Event()

        async def spawn(*args, **kwargs):
            spawned.set()
            return proc

        with patch.object(B.asyncio, "create_subprocess_exec", side_effect=spawn) as create:
            first = asyncio.create_task(c.start())
            await spawned.wait()
            second = asyncio.create_task(c.start())
            await asyncio.sleep(0)
            premature = second.done()
            ready(proc, 2)
            values = await asyncio.wait_for(asyncio.gather(first, second), 2)
        self.assertFalse(premature, "a running process without engine.ready is not ready")
        self.assertEqual(values[0], values[1])
        self.assertEqual(values[0]["pid"], 2)
        self.assertEqual(create.call_count, 1)

    async def test_stop_during_spawn_cannot_leave_late_process_running(self):
        c, proc = self.client(), FakeProc()
        entered, release = asyncio.Event(), asyncio.Event()

        async def spawn(*args, **kwargs):
            entered.set()
            await release.wait()
            ready(proc, 3)
            return proc

        with patch.object(B.asyncio, "create_subprocess_exec", side_effect=spawn):
            task = asyncio.create_task(c.start())
            await entered.wait()
            await c.stop()
            release.set()
            result = (await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), 2))[0]
        self.assertIsInstance(result, B.EngineUnavailable)
        self.assertFalse(c.running)
        self.assertTrue(proc.waited, "the late process must be reaped")

    async def test_stop_invalidates_already_queued_start_but_allows_new_start(self):
        c = self.client()
        spawned = asyncio.Event()
        procs = []

        async def spawn(*args, **kwargs):
            proc = FakeProc()
            procs.append(proc)
            if len(procs) > 1:
                ready(proc, len(procs))
            spawned.set()
            return proc

        with patch.object(B.asyncio, "create_subprocess_exec", side_effect=spawn):
            first = asyncio.create_task(c.start())
            await spawned.wait()
            queued = asyncio.create_task(c.start())
            await asyncio.sleep(0)
            await c.stop()
            outcomes = await asyncio.wait_for(asyncio.gather(first, queued, return_exceptions=True), 2)
            was_running, launches = c.running, len(procs)
            self.assertTrue(all(isinstance(value, B.EngineUnavailable) for value in outcomes))
            self.assertFalse(was_running)
            self.assertEqual(launches, 1)
            self.assertEqual((await c.start())["pid"], 2)

    async def test_old_pipe_eof_cannot_fail_new_rpc_or_report_disconnect(self):
        c, old, new = self.client(), FakeProc(), FakeProc()
        c._proc = old
        c.on_disconnected = Mock()
        reader = asyncio.create_task(c._read_loop())
        await asyncio.sleep(0)
        old.returncode = 1
        c._proc = new  # restart can occur before the old stdout reaches EOF
        future = asyncio.get_running_loop().create_future()
        c._pending[9] = future
        old.stdout.feed_eof()
        await reader
        was_done = future.done()
        if was_done:
            future.exception()
        else:
            future.cancel()
        self.assertFalse(was_done, "old EOF must not fail the new process's RPC")
        c.on_disconnected.assert_not_called()

    async def test_old_buffered_ready_cannot_replace_new_engine_info(self):
        c, old, new = self.client(), FakeProc(), FakeProc()
        c._proc = old
        reader = asyncio.create_task(c._read_loop())
        await asyncio.sleep(0)
        c._proc = new
        c._engine_info = {"pid": 22}
        ready(old, 11)
        old.stdout.feed_eof()
        await reader
        self.assertEqual(c.engine_info, {"pid": 22})

    async def test_cancelled_start_reaps_unready_process(self):
        c, proc = self.client(), FakeProc()
        spawned = asyncio.Event()

        async def spawn(*args, **kwargs):
            spawned.set()
            return proc

        with patch.object(B.asyncio, "create_subprocess_exec", side_effect=spawn):
            task = asyncio.create_task(c.start())
            await spawned.wait()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertFalse(c.running)
        self.assertTrue(proc.waited)

    async def test_current_eof_still_fails_its_pending_rpc(self):
        c, proc = self.client(), FakeProc()
        c._proc = proc
        c.on_disconnected = Mock()
        future = asyncio.get_running_loop().create_future()
        c._pending[1] = future
        proc.stdout.feed_eof()
        await c._read_loop()
        with self.assertRaises(B.EngineUnavailable):
            await future
        c.on_disconnected.assert_called_once()

    async def test_real_local_process_start_ping_stop_and_restart(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("Node unavailable for local protocol check")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "node_modules" / "mineflayer").mkdir(parents=True)
            (root / "index.js").write_text('''
const readline = require('node:readline');
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
setTimeout(() => send({method: 'notice', params: {event: 'engine.ready',
  data: {version: 'fixture', pid: process.pid}}}), 50);
readline.createInterface({input: process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  send({id: request.id, result: {pong: true, pid: process.pid}});
}).on('close', () => process.exit(0));
''', encoding="utf-8")
            c = B.EngineClient(B.EngineConfig(root, node_path=node))
            try:
                first, second = await asyncio.gather(c.start(), c.start())
                self.assertEqual(first, second)
                self.assertEqual((await c.call("ping"))["pid"], first["pid"])
                old = c._proc
                await c.stop()
                self.assertIsNotNone(old.returncode)
                restarted = await c.start()
                self.assertIsNot(c._proc, old)
                self.assertEqual((await c.call("ping"))["pid"], restarted["pid"])
            finally:
                await c.stop()


if __name__ == "__main__":
    unittest.main(verbosity=2)
