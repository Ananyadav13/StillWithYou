"""Download the Phase 3 model, retrying on the stalls this connection keeps hitting.

`snapshot_download` resumes from the partial `.incomplete` blob, so a retry loop costs
nothing but the bytes not yet fetched. Two failure modes seen on this box:
  - WinError 1314: the HF cache wants symlinks, which an unprivileged Windows account
    cannot create. HF_HUB_DISABLE_SYMLINKS makes it copy instead.
  - Silent stall: the socket stops delivering and the process sits there forever, so
    every attempt gets a timeout rather than being allowed to hang.
"""

import os
import sys
import time

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
# Fail an idle socket fast so the retry loop can restart it instead of hanging.
os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "30")

from huggingface_hub import snapshot_download  # noqa: E402

MODEL_ID = sys.argv[1] if len(sys.argv) > 1 else "cardiffnlp/twitter-xlm-roberta-base-sentiment"
ATTEMPTS = 40

for attempt in range(1, ATTEMPTS + 1):
    try:
        path = snapshot_download(MODEL_ID, allow_patterns=["*.json", "*.bin", "*.model", "*.txt", "*.safetensors"])
    except Exception as exc:  # noqa: BLE001 - any network error is worth another go
        print(f"attempt {attempt}/{ATTEMPTS} failed: {type(exc).__name__}: {str(exc)[:160]}", flush=True)
        time.sleep(3)
        continue

    print(f"OK {MODEL_ID} -> {path}", flush=True)
    total = 0
    for name in sorted(os.listdir(path)):
        size = os.path.getsize(os.path.join(path, name))
        total += size
        print(f"  {name}  {size / 1e6:.1f} MB", flush=True)
    print(f"  TOTAL {total / 1e6:.1f} MB", flush=True)
    break
else:
    print(f"gave up after {ATTEMPTS} attempts", flush=True)
    sys.exit(1)
