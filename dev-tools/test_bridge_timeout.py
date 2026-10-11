"""Total RPC deadlines include pipe backpressure, with no pending leaks."""
from __future__ import annotations

import asyncio
import json
import shutil
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _paths
_paths.require_astrbot("test_bridge_timeout")
B = _paths.plugin_module("bridge_client")


class Pipe:
    def __init__(self):
        self.writes = []
        self.release = asyncio.Event()
        self.entered = asyncio.Event()
        self.error = None

    def write(self, data):
        if self.error:
            raise self.error
        self.writes.append(json.loads(data))

    async def drain(self):
        self.entered.set()
        await self.release.wait()


class BridgeTimeoutTests(unittest.IsolatedAsyncioTestCase):
    def client(self, pipe=None):
        c = B.EngineClient(B.EngineConfig(_paths.ENGINE_DIR))
        c._proc = SimpleNamespace(returncode=None, stdin=pipe or Pipe())
        return c

    async def test_blocked_drain_times_out_and_late_response_is_ignored(self):
        c = self.client()
        with self.assertRaises(B.EngineError) as caught:
            await asyncio.wait_for(c.call("ping", timeout=0.03), 1)
        self.assertTrue(caught.exception.is_timeout)
        self.assertEqual(c._pending, {})
        c._handle_line(json.dumps({"id": 1, "result": {"pong": True}}).encode())
        self.assertEqual(c._pending, {})
        self.assertEqual(len(c._proc.stdin.writes), 1, "a timed-out action must not be replayed")

    async def test_cancellation_during_write_cleans_pending(self):
        c = self.client()
        task = asyncio.create_task(c.call("ping", timeout=10))
        await c._proc.stdin.entered.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(c._pending, {})

    async def test_response_timeout_and_write_error_keep_contract(self):
        c = self.client()
        c._proc.stdin.release.set()
        with self.assertRaises(B.EngineError) as caught:
            await c.call("ping", timeout=0.02)
        self.assertTrue(caught.exception.is_timeout)
        self.assertEqual(c._pending, {})
        c._proc.stdin.error = BrokenPipeError("closed")
        with self.assertRaises(B.EngineUnavailable):
            await c.call("ping", timeout=1)
        self.assertEqual(c._pending, {})

    async def test_early_response_and_rpc_error_are_preserved(self):
        for response in ({"result": {"pong": True}}, {"error": {"code": 1002, "message": "busy"}}):
            with self.subTest(response=response):
                c = self.client()
                task = asyncio.create_task(c.call("ping", timeout=1))
                await c._proc.stdin.entered.wait()
                c._handle_line(json.dumps({"id": 1, **response}).encode())
                c._proc.stdin.release.set()
                if "error" in response:
                    with self.assertRaises(B.EngineError) as caught:
                        await task
                    self.assertEqual(caught.exception.code, 1002)
                else:
                    self.assertEqual(await task, {"pong": True})
                self.assertEqual(c._pending, {})

    async def test_invalid_serialization_cleans_pending(self):
        c = self.client()
        with self.assertRaises(TypeError):
            await c.call("bad", {"value": object()})
        self.assertEqual(c._pending, {})
        self.assertEqual(c._proc.stdin.writes, [])

    async def test_real_pipe_backpressure_cannot_hold_small_ping(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("Node is unavailable for local pipe check")
        proc = await asyncio.create_subprocess_exec(node, "-e", "setInterval(()=>{},1000)",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        c = self.client()
        c._proc = proc
        tasks = []
        try:
            large = asyncio.create_task(c.say("x" * 2_000_000, timeout=0.05))
            tasks.append(large)
            await asyncio.sleep(0.01)
            ping = asyncio.create_task(c.ping(timeout=0.05))
            tasks.append(ping)
            results = await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=True), 2)
            self.assertIsInstance(results[0], B.EngineError)
            self.assertTrue(results[0].is_timeout)
            self.assertIs(results[1], False)
            self.assertEqual(c._pending, {})
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            proc.kill()
            await proc.wait()


if __name__ == "__main__":
    unittest.main(verbosity=2)
