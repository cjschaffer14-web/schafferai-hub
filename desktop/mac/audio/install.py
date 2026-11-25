#!/usr/bin/env python3
"""Install only the audio helper; the working desktop app and its private config stay intact."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import time

LABEL = 'com.schafferai.desktop-audio'

def run(*args, check=True):
    return subprocess.run(args, check=check, capture_output=True, text=True)

def atomic_write(path, data):
    fd, name = tempfile.mkstemp(prefix='.audio-', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, required=True)
    parser.add_argument('--start', action='store_true')
    args = parser.parse_args()
    source = args.app.resolve()
    executable = source / 'Contents/MacOS/SchafferDesktopAudio'
    if not executable.is_file():
        raise SystemExit('The built audio helper was not found.')
    run('/usr/bin/codesign', '--verify', '--strict', str(source))
    support = Path.home() / 'Library/Application Support/SchafferDesktop'
    config = support / 'config.json'
    if not config.is_file():
        raise SystemExit('Install and configure Schaffer Desktop first.')
    # Read only the configuration metadata: the key is never logged or copied elsewhere.
    if config.stat().st_mode & 0o077:
        raise SystemExit('The desktop config must remain owner-readable only (mode 600).')
    app = support / 'SchafferDesktopAudio.app'
    agents = Path.home() / 'Library/LaunchAgents'
    agents.mkdir(parents=True, exist_ok=True)
    logs = Path.home() / 'Library/Logs/SchafferDesktop'
    logs.mkdir(parents=True, exist_ok=True)
    domain = 'gui/' + str(os.getuid())
    run('/bin/launchctl', 'bootout', domain + '/' + LABEL, check=False)
    staging = Path(tempfile.mkdtemp(prefix='.audio-stage-', dir=support))
    try:
        staged = staging / app.name
        run('/usr/bin/ditto', str(source), str(staged))
        run('/usr/bin/codesign', '--verify', '--strict', str(staged))
        if app.exists():
            os.replace(app, support / ('SchafferDesktopAudio.previous.' + str(time.time_ns()) + '.app'))
        os.replace(staged, app)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    plist = agents / (LABEL + '.plist')
    job = {
        'Label': LABEL,
        'ProgramArguments': [str(app / 'Contents/MacOS/SchafferDesktopAudio'), '--config', str(config)],
        'RunAtLoad': True,
        'KeepAlive': {'SuccessfulExit': False},
        'ThrottleInterval': 10,
        'LimitLoadToSessionType': 'Aqua',
        'ProcessType': 'Interactive',
        'StandardOutPath': str(logs / 'audio.log'),
        'StandardErrorPath': str(logs / 'audio-error.log'),
    }
    atomic_write(plist, plistlib.dumps(job))
    if args.start:
        run('/bin/launchctl', 'bootstrap', domain, str(plist))
    print(json.dumps({'installedApp': str(app), 'launchAgent': str(plist), 'started': args.start}))

if __name__ == '__main__':
    main()
