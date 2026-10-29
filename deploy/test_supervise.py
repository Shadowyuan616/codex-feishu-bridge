"""Run with python3 -m unittest discover -s deploy -p 'test_*.py'."""
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest


SUPERVISOR = Path(__file__).with_name("supervise.py")


class SupervisorTests(unittest.TestCase):
    def wait_for(self, predicate, seconds=4):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(0.02)
        self.fail("supervisor did not reach expected state")

    def test_exclusive_lock_rotation_and_owned_worker_shutdown(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary) / "state"
            # Ignore TERM so the test exercises bounded forced shutdown too.
            worker = ("import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); "
                      "print('x'*3500,flush=True); time.sleep(30)")
            command = [sys.executable, str(SUPERVISOR), "--state-dir", str(state),
                       "--stop-grace", "0.3", "--log-bytes", "1024", "--",
                       sys.executable, "-c", worker]
            first = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                self.wait_for(lambda: (state / "worker.pid").exists() and
                              (state / "logs/bridge.log.1").exists())
                worker_pid = int((state / "worker.pid").read_text())
                duplicate = subprocess.run(command, capture_output=True, timeout=3)
                self.assertEqual(duplicate.returncode, 75)
                self.assertIn(b"already owns", duplicate.stderr)
                first.send_signal(signal.SIGTERM)
                self.assertEqual(first.wait(timeout=4), 0)
                self.assertFalse((state / "supervisor.pid").exists())
                self.assertFalse((state / "worker.pid").exists())
                self.assertTrue((state / "supervisor.lock").exists())
                with self.assertRaises(ProcessLookupError):
                    os.kill(worker_pid, 0)
                for log in (state / "logs").glob("bridge.log*"):
                    self.assertLessEqual(log.stat().st_size, 1024)
            finally:
                if first.poll() is None:
                    first.send_signal(signal.SIGTERM)
                    first.wait(timeout=4)
                first.communicate()

    def test_failed_worker_restarts_with_backoff(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary) / "state"
            command = [sys.executable, str(SUPERVISOR), "--state-dir", str(state),
                       "--min-backoff", "0.05", "--max-backoff", "0.1", "--",
                       sys.executable, "-c", "raise SystemExit(7)"]
            process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            log = state / "logs/bridge.log"
            try:
                self.wait_for(lambda: log.exists() and "restarting in 0.10s" in log.read_text())
                process.send_signal(signal.SIGTERM)
                self.assertEqual(process.wait(timeout=4), 0)
                content = log.read_text()
                self.assertIn("restarting in 0.05s", content)
                self.assertGreaterEqual(content.count("worker started"), 2)
                self.assertFalse((state / "supervisor.pid").exists())
            finally:
                if process.poll() is None:
                    process.send_signal(signal.SIGTERM)
                    process.wait(timeout=4)
                process.communicate()


if __name__ == "__main__":
    unittest.main()
