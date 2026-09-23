#!/usr/bin/env python3
"""Activate the new backend and writable Lexar mount. Run with sudo.

No media files are moved or deleted by this command. Dangerous mode only
moves a file when a browser user chooses Delete.
"""
import json
import os
import re
import subprocess
import time
import urllib.request
from pathlib import Path
from datetime import date

MOUNT = "/mnt/edging-heaven"
UUID = "46C6-231E"
FSTAB = Path("/etc/fstab")
BACKUP = Path("/etc/fstab.before-dangerous")
DOCS = Path("/home/qwerty/infomds")


def run(*args):
    return subprocess.run(args, check=True, text=True, capture_output=True).stdout.strip()


def update_docs(active, detail):
    for name in ("EDGING-HEAVEN.md", "MANIFEST.md"):
        path = DOCS / name
        if not path.exists():
            continue
        content = path.read_text()
        start = "<!-- dangerous-status-start -->"
        end = "<!-- dangerous-status-end -->"
        if start not in content or end not in content:
            continue
        if active:
            text = ("Dangerous deployment: **active**. The backend was restarted and the API reports "
                    "`canTrash: true`. The Lexar mount is writable (`rw`) and `/etc/fstab` preserves "
                    "this across reboot. No real media was deleted during deployment. Reboot and "
                    "physical-device testing remain unverified.")
        else:
            text = "Dangerous deployment: **incomplete**. " + detail
        left, rest = content.split(start, 1)
        _, right = rest.split(end, 1)
        content = left + start + "\n" + text + "\n" + end + right
        if active:
            content = content.replace("auto-mounted read-only at `/mnt/edging-heaven`", "auto-mounted writable at `/mnt/edging-heaven`")
            content = content.replace("vfat ro,nosuid", "vfat rw,nosuid")
            content = content.replace("| Read-only drive | Browsing needs no writes to USB. Ratings live on the SSD, so the app cannot alter drive contents. To add media, use another computer or deliberately remount it for writing. |",
                                      "| Writable drive with local trash | Dangerous mode moves originals into `.heaven-trash` on the same drive. This is fast and reversible; it does not free disk space until trash is manually removed. Ratings remain on the SSD. |")
            content = content.replace("`ro` forbids writes.", "`rw` permits the app to move and restore files for Dangerous mode.")
            content = content.replace("The mount is read-only. For a clean removal", "The mount is writable. For a clean removal")
            content = content.replace("read-only Lexar", "writable Lexar")
            content = content.replace("the Lexar USB drive, read-only automount", "the Lexar USB drive, writable automount")
            if name == "EDGING-HEAVEN.md":
                content = re.sub(r"\*\*Status:.*?\*\*", "**Status: running and enabled. The monochrome interface, new backend, and writable Dangerous mode are active. Physical-device, reboot, and mobile-data tests remain unverified.**", content, count=1)
            else:
                content = re.sub(r"^Last verified:.*$", f"Last verified: {date.today().isoformat()} (Edging Heaven backend active, canTrash true and writable Lexar mount verified; reboot and physical-device tests pending. Other services retain their topic verification notes).", content, count=1, flags=re.MULTILINE)
                block = start + "\n" + text + "\n" + end
                gaps = content.find("## Known gaps")
                if gaps >= 0 and content.find(start) > gaps:
                    content = content.replace(block, "Edging Heaven still needs physical Safari/device, reboot, and mobile-data playback checks.", 1)
                    content = content.replace("Next free tailnet port:", block + "\n\nNext free tailnet port:", 1)
        path.write_text(content)


def main():
    if os.geteuid() != 0:
        raise SystemExit("Run: sudo python3 /home/qwerty/git/edgingHeaven/deploy/enable-dangerous.py")
    original = FSTAB.read_text()
    lines = original.splitlines()
    matches = []
    for index, line in enumerate(lines):
        fields = line.split()
        if fields and not line.lstrip().startswith("#") and len(fields) >= 4:
            if fields[0] == f"UUID={UUID}" or fields[1] == MOUNT:
                if fields[0] != f"UUID={UUID}" or fields[1] != MOUNT or fields[2] != "vfat":
                    raise SystemExit("Unexpected mount entry; nothing changed.")
                matches.append(index)
    if len(matches) != 1:
        raise SystemExit("Expected exactly one Lexar entry; nothing changed.")
    index = matches[0]
    fields = lines[index].split()
    options = [option for option in fields[3].split(",") if option not in {"ro", "rw"}]
    fields[3] = ",".join(["rw", *options])
    lines[index] = " ".join(fields)
    if not BACKUP.exists():
        BACKUP.write_text(original)
    try:
        FSTAB.write_text("\n".join(lines) + "\n")
        run("systemctl", "daemon-reload")
        run("mount", "-o", "remount,rw", MOUNT)
        run("systemctl", "restart", "edging-heaven.service")
        for _ in range(30):
            try:
                with urllib.request.urlopen("http://127.0.0.1:8420/api/state", timeout=15) as response:
                    payload = json.load(response)
                if payload.get("canTrash") and "dangerousKind" in payload.get("settings", {}):
                    break
            except (OSError, ValueError):
                pass
            time.sleep(1)
        else:
            raise RuntimeError("The new backend did not report a writable library.")
        print(run("findmnt", "-rn", "-t", "vfat", "-o", "TARGET,OPTIONS", MOUNT))
        print(run("systemctl", "is-active", "edging-heaven.service"))
        update_docs(True, "")
        print("Ready. Reload the app. The backend and writable mount are active; infomds updated.")
    except Exception as error:
        FSTAB.write_text(original)
        rollback = "fstab restored. "
        try:
            run("systemctl", "daemon-reload")
            if "ro" in original.splitlines()[index].split()[3].split(","):
                run("mount", "-o", "remount,ro", MOUNT)
            rollback += "Original mount policy restored. "
        except Exception:
            rollback += "Mount rollback needs manual inspection with findmnt. "
        update_docs(False, rollback + "Deployment failed; inspect `systemctl status edging-heaven.service` and rerun the activation command. " + str(error))
        raise


if __name__ == "__main__":
    main()
