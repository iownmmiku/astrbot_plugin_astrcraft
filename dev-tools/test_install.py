"""Run the Windows installer in isolated fixtures with fake Node/npm commands.

No dependency install, network access, or existing AstrBot directory is involved.
The script bytes are copied verbatim so its real $PSScriptRoot resolution is tested.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


REPO = Path(__file__).resolve().parents[1]
SHELLS = [path for name in ("powershell.exe", "pwsh.exe") if (path := shutil.which(name))]
if os.name != "nt" or not SHELLS:
    print("SKIP: Windows PowerShell is required for the installer execution checks")
    raise SystemExit(0)


class InstallerTests(unittest.TestCase):
    def run_installer(self, shell, *, version="v22.13.0", node_exit=0,
                      npm_exit=0, missing=None, lock=True):
        with tempfile.TemporaryDirectory(prefix="astrcraft install ") as temp:
            root = Path(temp) / "plugin with spaces"
            scripts = root / "dev-tools"
            engine = root / "engine"
            fakebin = Path(temp) / "fakebin"
            scripts.mkdir(parents=True)
            engine.mkdir()
            fakebin.mkdir()
            shutil.copyfile(REPO / "dev-tools" / "install.ps1", scripts / "install.ps1")
            (engine / "package.json").write_text('{"name":"installer-fixture"}', encoding="utf-8")
            if lock:
                (engine / "package-lock.json").write_text('{"lockfileVersion":3}', encoding="utf-8")
            for name in ("canvas", "mineflayer", "minecraft-data", "mineflayer-pathfinder"):
                if name != missing:
                    pkg = engine / "node_modules" / name / "package.json"
                    pkg.parent.mkdir(parents=True)
                    pkg.write_text(json.dumps({"name": name, "version": "1.0.0"}), encoding="utf-8")
            trace = Path(temp) / "npm-trace.txt"
            (fakebin / "node.cmd").write_text(
                f"@echo off\necho {version}\nexit /b {node_exit}\n", encoding="ascii")
            (fakebin / "npm.cmd").write_text(
                '@echo off\n> "%ASTRCRAFT_INSTALL_TRACE%" echo cwd=%CD%\n'
                + "".join(f'>> "%ASTRCRAFT_INSTALL_TRACE%" echo arg{i}=%~{i}\n' for i in range(1, 7))
                + f"exit /b {npm_exit}\n", encoding="ascii")
            env = os.environ.copy()
            # Exclude the real Node/npm installation entirely, even if the script regresses.
            env["PATH"] = os.pathsep.join((str(fakebin), str(Path(env["SYSTEMROOT"]) / "System32")))
            env["ASTRCRAFT_INSTALL_TRACE"] = str(trace)
            result = subprocess.run(
                [shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                 "-File", str(scripts / "install.ps1")],
                cwd=temp, env=env, capture_output=True, timeout=30,
            )
            details = (result.stdout + result.stderr).decode("utf-8", errors="replace")
            called = trace.read_text(errors="replace") if trace.exists() else ""
            expected_cache = str(root / "_npm_cache")
            return result.returncode, called, details, str(engine), expected_cache

    def test_current_layout_uses_locked_install_from_engine(self):
        for shell in SHELLS:
            with self.subTest(shell=shell):
                code, called, output, engine, cache = self.run_installer(shell)
                self.assertEqual(code, 0, output)
                self.assertIn(f"cwd={engine}\n", called)
                self.assertIn("arg1=ci\n", called)
                self.assertIn(f"arg2=--cache\narg3={cache}\n", called)
                self.assertIn("arg4=--no-audit\narg5=--no-fund\narg6=\n", called)

    def test_old_node_rejected_before_npm(self):
        for shell in SHELLS:
            for version in ("v18.20.0", "v20.19.0"):
                with self.subTest(shell=shell, version=version):
                    code, called, output, *_ = self.run_installer(shell, version=version)
                    self.assertNotEqual(code, 0, output)
                    self.assertEqual(called, "", output)
                    self.assertIn("22", output)

    def test_failed_node_probe_rejected_before_npm(self):
        for shell in SHELLS:
            with self.subTest(shell=shell):
                code, called, output, *_ = self.run_installer(shell, node_exit=7)
                self.assertNotEqual(code, 0, output)
                self.assertEqual(called, "", output)

    def test_missing_lock_rejected_before_npm(self):
        for shell in SHELLS:
            with self.subTest(shell=shell):
                code, called, output, *_ = self.run_installer(shell, lock=False)
                self.assertNotEqual(code, 0, output)
                self.assertEqual(called, "", output)
                self.assertIn("package-lock.json", output)

    def test_npm_failure_not_reported_as_success(self):
        for shell in SHELLS:
            with self.subTest(shell=shell):
                code, called, output, *_ = self.run_installer(shell, npm_exit=19)
                self.assertNotEqual(code, 0, output)
                self.assertIn("arg1=ci\n", called, output)
                self.assertIn("19", output)

    def test_missing_required_dependency_not_reported_as_success(self):
        for shell in SHELLS:
            for missing in ("canvas", "mineflayer"):
                with self.subTest(shell=shell, missing=missing):
                    code, called, output, *_ = self.run_installer(shell, missing=missing)
                    self.assertNotEqual(code, 0, output)
                    self.assertIn("arg1=ci\n", called, output)
                    self.assertIn(missing, output)


if __name__ == "__main__":
    unittest.main(verbosity=2)
