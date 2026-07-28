"""Measure what the first request after a fresh backend start actually costs.

    .venv/Scripts/python.exe scripts/measure_cold_start.py --label before

Starts a real uvicorn process, waits only until the port accepts a TCP connection, then
immediately sends a real POST /analyze-preview and times it. That "immediately" is the
whole point: the failure this measures is invisible unless the request races the boot.

Why a subprocess rather than TestClient: TestClient runs lifespan in-process and would
hide exactly the thing under test — whether uvicorn is accepting connections before the
model is ready.

Three numbers come out of it:

  boot_to_accept  how long until the socket takes a connection
  first_request   what the first caller pays
  second_request  steady state, for contrast

The extension holds a 3s client deadline, so `first_request` is compared against that
rather than against a general sense of "fast".
"""

from __future__ import annotations

import argparse
import json
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
PYTHON = BACKEND / ".venv" / "Scripts" / "python.exe"

HEATED = "Forget it. I'm done asking you for anything."


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def port_accepts(port: int) -> bool:
    """True once the OS will complete a TCP handshake on the port."""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.25):
            return True
    except OSError:
        return False


def post(port: int, path: str, payload: dict, timeout: float) -> tuple[float, object]:
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = json.loads(response.read())
        return (time.perf_counter() - started) * 1000, body
    except (urllib.error.URLError, TimeoutError, socket.timeout) as exc:
        return (time.perf_counter() - started) * 1000, {"error": f"{type(exc).__name__}: {exc}"}


def get(port: int, path: str, timeout: float) -> tuple[float, object]:
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=timeout) as response:
            return (time.perf_counter() - started) * 1000, json.loads(response.read())
    except Exception as exc:  # noqa: BLE001
        return (time.perf_counter() - started) * 1000, {"error": f"{type(exc).__name__}: {exc}"}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", default="run")
    parser.add_argument("--deadline", type=float, default=3.0, help="client deadline in seconds")
    args = parser.parse_args()

    port = free_port()
    log_path = BACKEND / f"coldstart-{args.label}.log"

    print(f"=== cold-start measurement: {args.label} ===")
    print(f"    port {port}, client deadline {args.deadline}s\n")

    process_started = time.perf_counter()
    with log_path.open("w", encoding="utf-8") as log_file:
        server = subprocess.Popen(
            [str(PYTHON), "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port)],
            cwd=str(BACKEND),
            stdout=log_file,
            stderr=subprocess.STDOUT,
        )

        try:
            # Wait only for the socket, NOT for a successful request. Waiting for a 200
            # would silently absorb the very delay being measured.
            while not port_accepts(port):
                if server.poll() is not None:
                    print("server exited during boot; see", log_path)
                    return 1
                if time.perf_counter() - process_started > 90:
                    print("timed out waiting for the port")
                    return 1
                time.sleep(0.02)

            boot_to_accept = (time.perf_counter() - process_started) * 1000
            print(f"boot -> port accepts TCP      {boot_to_accept:8.1f} ms")

            # Health immediately, to see whether the app claims readiness before the
            # model is loaded.
            health_ms, health_body = get(port, "/health", timeout=args.deadline)
            print(f"GET  /health (immediate)      {health_ms:8.1f} ms   {json.dumps(health_body)}")

            first_ms, first_body = post(
                port, "/analyze-preview", {"content": HEATED}, timeout=args.deadline
            )
            over = first_ms > args.deadline * 1000
            verdict = "OVER DEADLINE" if over or "error" in first_body else "within deadline"
            print(f"POST /analyze-preview  #1     {first_ms:8.1f} ms   <- {verdict}")
            print(f"     {json.dumps(first_body)[:150]}")

            # Generous timeout on purpose: this one is not testing the deadline, it is
            # establishing what the load actually costs end to end. A short timeout here
            # would leave the real number unmeasured.
            second_ms, second_body = post(
                port, "/analyze-preview", {"content": "Thanks for sorting that out today."},
                timeout=180,
            )
            print(f"POST /analyze-preview  #2     {second_ms:8.1f} ms   <- waits out the load")
            print(f"     {json.dumps(second_body)[:150]}")

            third_ms, third_body = post(
                port, "/analyze-preview", {"content": "You never listen to me, every time."},
                timeout=30,
            )
            print(f"POST /analyze-preview  #3     {third_ms:8.1f} ms   <- steady state")
            print(f"     {json.dumps(third_body)[:150]}")

            # Repeat of the very first call, now that both this process and the server
            # are warm. The delta against the earlier /health isolates per-process
            # first-call overhead in the CLIENT (socket setup, urllib machinery) from
            # anything the server is actually doing, so the first-request figure above
            # is not silently credited to the fix or blamed on it.
            health2_ms, _ = get(port, "/health", timeout=args.deadline)
            print(f"GET  /health (warm, control)  {health2_ms:8.1f} ms")

        finally:
            server.terminate()
            try:
                server.wait(timeout=15)
            except subprocess.TimeoutExpired:
                server.kill()

    print(f"\n--- server log ({log_path.name}) ---")
    for line in log_path.read_text(encoding="utf-8", errors="replace").splitlines():
        if any(k in line for k in ("preview", "startup", "model", "Uvicorn", "Application", "Started", "ready")):
            print(f"    {line}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
