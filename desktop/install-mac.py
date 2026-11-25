#!/usr/bin/env python3
"""Install the owner's desktop connection with a private config and login job."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import time
from urllib.parse import urlsplit

LABEL = "com.schafferai.desktop-portal"

def atomic_write(path, data, mode=0o600):
    fd, name = tempfile.mkstemp(prefix=".desktop-", dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)

def run(*args, check=True):
    return subprocess.run(args, check=check, capture_output=True, text=True)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True,
                        help="Existing private producer configuration; contents are never printed")
    parser.add_argument("--relay", required=True)
    parser.add_argument("--start", action="store_true")
    args = parser.parse_args()
    address = urlsplit(args.relay)
    if (address.scheme != "https" or not address.hostname or address.username or
            address.password or address.query or address.fragment):
        raise SystemExit("A permanent HTTPS relay origin is required.")
    source = args.app.resolve()
    executable = source / "Contents/MacOS/SchafferDesktop"
    if not executable.is_file():
        raise SystemExit("The built Schaffer Desktop app was not found.")
    run("/usr/bin/codesign", "--verify", "--strict", str(source))
    config = json.loads(args.config.read_text())
    key = config.get("producerKey", "")
    if not isinstance(key, str) or not 32 <= len(key) <= 249 or "\n" in key or "\r" in key:
        raise SystemExit("Private producer configuration is invalid.")
    home = Path.home()
    support = home / "Library/Application Support/SchafferDesktop"
    support.mkdir(parents=True, exist_ok=True)
    support.chmod(0o700)
    app = support / "SchafferDesktop.app"
    config_path = support / "config.json"
    agents = home / "Library/LaunchAgents"
    agents.mkdir(parents=True, exist_ok=True)
    plist = agents / (LABEL + ".plist")
    logs = home / "Library/Logs/SchafferDesktop"
    logs.mkdir(parents=True, exist_ok=True)
    domain = "gui/" + str(os.getuid())
    # Only this application's job is affected; missing jobs are expected on first install.
    run("/bin/launchctl", "bootout", domain + "/" + LABEL, check=False)
    staging = Path(tempfile.mkdtemp(prefix=".app-stage-", dir=support))
    try:
        staged_app = staging / "SchafferDesktop.app"
        run("/usr/bin/ditto", str(source), str(staged_app))
        run("/usr/bin/codesign", "--verify", "--strict", str(staged_app))
        if app.exists():
            backup = support / ("SchafferDesktop.previous." + str(time.time_ns()) + ".app")
            os.replace(app, backup)
        os.replace(staged_app, app)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    atomic_write(config_path, (json.dumps({"relayUrl": args.relay.rstrip("/"),
        "producerKey": key, "transport": "http"}, indent=2) + "\n").encode())
    job = {
        "Label": LABEL,
        "ProgramArguments": [str(app / "Contents/MacOS/SchafferDesktop"), "--config", str(config_path)],
        "RunAtLoad": True,
        "KeepAlive": {"SuccessfulExit": False},
        "ThrottleInterval": 10,
        "LimitLoadToSessionType": "Aqua",
        "ProcessType": "Interactive",
        "StandardOutPath": str(logs / "agent.log"),
        "StandardErrorPath": str(logs / "agent-error.log"),
    }
    atomic_write(plist, plistlib.dumps(job))
    if args.start:
        run("/bin/launchctl", "bootstrap", domain, str(plist))
    print(json.dumps({"installedApp": str(app), "launchAgent": str(plist),
                      "relayUrl": args.relay.rstrip("/"), "started": args.start}))

if __name__ == "__main__":
    main()
