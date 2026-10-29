#!/usr/bin/env python3
"""Unprivileged POSIX supervisor for this bridge; never manages the Codex daemon."""
import argparse
import errno
import fcntl
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import tempfile
import time


class RotatingLog:
    def __init__(self, path, max_bytes, backups):
        self.path = Path(path)
        self.max_bytes = max_bytes
        self.backups = backups
        self.file = self._open()

    def _open(self):
        flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(self.path, flags, 0o600)
        os.fchmod(fd, 0o600)
        return os.fdopen(fd, "ab", buffering=0)

    def write(self, data):
        while data:
            remaining = self.max_bytes - os.fstat(self.file.fileno()).st_size
            if remaining <= 0:
                self.rotate()
                remaining = self.max_bytes
            self.file.write(data[:remaining])
            data = data[remaining:]

    def event(self, message):
        stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self.write(f"{stamp} supervisor: {message}\n".encode())

    def rotate(self):
        self.file.close()
        for index in range(self.backups, 0, -1):
            source = self.path if index == 1 else Path(f"{self.path}.{index - 1}")
            target = Path(f"{self.path}.{index}")
            if source.exists():
                os.replace(source, target)
        self.file = self._open()

    def close(self):
        self.file.close()


def write_pid(path, pid):
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.write(fd, f"{pid}\n".encode())
        os.fsync(fd)
    finally:
        os.close(fd)
    try:
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def remove_own_pid(path, pid):
    try:
        if path.read_text().strip() == str(pid):
            path.unlink()
    except FileNotFoundError:
        pass


def signal_group(process, sig):
    # start_new_session=True makes this PID the group owned by this supervisor.
    try:
        os.killpg(process.pid, sig)
    except ProcessLookupError:
        pass


def run_worker(command, state, log, stopping, grace):
    process = subprocess.Popen(
        command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, start_new_session=True, close_fds=True,
    )
    pid_path = state / "worker.pid"
    selector = selectors.DefaultSelector()
    terminate_at = None
    killed = False
    try:
        write_pid(pid_path, process.pid)
        log.event(f"worker started pid={process.pid}")
        selector.register(process.stdout, selectors.EVENT_READ)
        while True:
            now = time.monotonic()
            exited = process.poll() is not None
            if (stopping[0] or exited) and terminate_at is None:
                # Also clean up this worker's remaining children before a restart.
                signal_group(process, signal.SIGTERM)
                terminate_at = now + grace
            if terminate_at is not None and now >= terminate_at and not killed:
                signal_group(process, signal.SIGKILL)
                killed = True
            for key, _ in selector.select(0.2):
                data = os.read(key.fd, 65_536)
                if data:
                    log.write(data)
                else:
                    selector.unregister(key.fileobj)
            if process.poll() is not None and not selector.get_map():
                # Children that deliberately closed their inherited pipes still
                # belong to our group and must not survive into the next worker.
                signal_group(process, signal.SIGKILL)
                return process.wait()
            if killed and process.poll() is not None:
                return process.wait()
    finally:
        signal_group(process, signal.SIGTERM)
        try:
            process.wait(timeout=grace)
        except subprocess.TimeoutExpired:
            signal_group(process, signal.SIGKILL)
            process.wait()
        selector.close()
        process.stdout.close()
        remove_own_pid(pid_path, process.pid)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--log-dir", type=Path)
    parser.add_argument("--min-backoff", type=float, default=1.0)
    parser.add_argument("--max-backoff", type=float, default=60.0)
    parser.add_argument("--stable-seconds", type=float, default=120.0)
    parser.add_argument("--stop-grace", type=float, default=15.0)
    parser.add_argument("--log-bytes", type=int, default=5 * 1024 * 1024)
    parser.add_argument("--log-backups", type=int, default=3)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("provide the worker command after --")
    if not args.state_dir.is_absolute() or (args.log_dir and not args.log_dir.is_absolute()):
        parser.error("state-dir and log-dir must be absolute")
    if not (0 < args.min_backoff <= args.max_backoff and args.stop_grace > 0 and
            args.stable_seconds > 0 and args.log_bytes >= 1024 and args.log_backups >= 1):
        parser.error("invalid supervisor timing or rotation limits")
    state = args.state_dir
    logs = args.log_dir or state / "logs"
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    logs.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock_fd = os.open(state / "supervisor.lock", os.O_CREAT | os.O_RDWR |
                      getattr(os, "O_NOFOLLOW", 0), 0o600)
    os.fchmod(lock_fd, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as error:
        os.close(lock_fd)
        if error.errno in (errno.EACCES, errno.EAGAIN):
            print("A bridge supervisor already owns this state directory.", file=sys.stderr)
            return 75
        raise
    # Keep the lock inode: unlinking a flock file can permit two live owners.
    log = RotatingLog(logs / "bridge.log", args.log_bytes, args.log_backups)
    pid_path = state / "supervisor.pid"
    stopping = [False]
    def stop(_signum, _frame):
        stopping[0] = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    write_pid(pid_path, os.getpid())
    backoff = args.min_backoff
    try:
        while not stopping[0]:
            started = time.monotonic()
            try:
                code = run_worker(command, state, log, stopping, args.stop_grace)
                log.event(f"worker exited code={code}")
            except OSError as error:
                # Do not print argv or the environment; either may hold credentials.
                log.event(f"worker launch or I/O error errno={error.errno}")
            if stopping[0]:
                break
            if time.monotonic() - started >= args.stable_seconds:
                backoff = args.min_backoff
            log.event(f"restarting in {backoff:.2f}s")
            deadline = time.monotonic() + backoff
            while not stopping[0] and time.monotonic() < deadline:
                time.sleep(min(0.2, max(0, deadline - time.monotonic())))
            backoff = min(args.max_backoff, backoff * 2)
    finally:
        remove_own_pid(pid_path, os.getpid())
        log.event("supervisor stopped")
        log.close()
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        os.close(lock_fd)
    return 0


if __name__ == "__main__":
    sys.exit(main())
