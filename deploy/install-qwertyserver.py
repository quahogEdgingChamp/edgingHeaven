#!/usr/bin/env python3
"""Install this machine's Lexar mount and private media browser. Run with sudo."""
import json
import os
import pwd
import shutil
import subprocess
import time
import urllib.request
from pathlib import Path

REPO = Path("/home/qwerty/git/edgingHeaven")
HOME = Path("/home/qwerty")
MOUNT = Path("/mnt/edging-heaven")
UUID = "46C6-231E"
DATA = HOME / ".local/share/edging-heaven"
DOC = HOME / "infomds/EDGING-HEAVEN.md"
URL = "https://qwertyserver.tailc27f97.ts.net:8446"
USER = pwd.getpwnam("qwerty")


def run(*args):
    return subprocess.run(args, check=True, text=True, capture_output=True).stdout.strip()


def user_run(*args):
    return run("runuser", "-u", "qwerty", "--", *args)


def backup(path):
    saved = path.with_name(path.name + ".before-edging-heaven")
    if path.exists() and not saved.exists():
        shutil.copy2(path, saved)


def write_user(path, contents, mode=0o600):
    path.write_text(contents)
    path.chmod(mode)
    os.chown(path, USER.pw_uid, USER.pw_gid)


def main():
    if os.geteuid() != 0:
        raise SystemExit("Run: sudo python3 /home/qwerty/git/edgingHeaven/deploy/install-qwertyserver.py")
    DOC.parent.mkdir(exist_ok=True)
    os.chown(DOC.parent, USER.pw_uid, USER.pw_gid)
    write_user(DOC, (REPO / "deploy/EDGING-HEAVEN.md").read_text(), 0o644)
    try:
        install()
    except Exception as error:
        detail = getattr(error, "stderr", "") or str(error)
        with DOC.open("a") as handle:
            handle.write("\n## Installation incomplete\n\nThe installer stopped with:\n\n```text\n" + detail + "\n```\n\nEarlier steps may already be installed. Inspect the status commands above, then rerun the installer.\n")
        raise


def install():
    device = Path("/dev/disk/by-uuid") / UUID
    if not device.exists():
        raise RuntimeError("Plug in the Lexar drive (UUID 46C6-231E), then rerun.")
    # Do not replace any unrelated mount or Tailscale mapping.
    serve = json.loads(user_run("tailscale", "serve", "status", "--json"))
    for host, config in serve.get("Web", {}).items():
        if host.endswith(":8446") and config.get("Handlers", {}).get("/", {}).get("Proxy") != "http://127.0.0.1:8420":
            raise RuntimeError("Tailscale HTTPS port 8446 is already assigned to another service.")
    mounted = subprocess.run(["findmnt", "-rn", "-S", str(device.resolve()), "-o", "TARGET"], text=True, capture_output=True).stdout.splitlines()
    if any(target != str(MOUNT) for target in mounted):
        raise RuntimeError("Lexar is already mounted elsewhere: " + ", ".join(mounted))
    fstab = Path("/etc/fstab")
    entry = f"UUID={UUID} {MOUNT} vfat ro,nosuid,nodev,noexec,uid={USER.pw_uid},gid={USER.pw_gid},umask=0077,nofail,x-systemd.automount,x-systemd.device-timeout=2s,x-systemd.mount-timeout=10s 0 0"
    old = fstab.read_text()
    for line in old.splitlines():
        fields = line.split()
        if fields and not line.lstrip().startswith("#") and (fields[0] == f"UUID={UUID}" or (len(fields) > 1 and fields[1] == str(MOUNT))):
            if line != entry:
                raise RuntimeError("An existing fstab entry needs review: " + line)
    backup(fstab)
    if entry not in old.splitlines():
        fstab.write_text(old.rstrip() + "\n\n# Edging Heaven: Lexar, read-only, mount on access\n" + entry + "\n")
    MOUNT.mkdir(exist_ok=True)
    run("systemctl", "daemon-reload")
    run("systemctl", "start", "mnt-edging\\x2dheaven.automount")
    run("systemctl", "start", "mnt-edging\\x2dheaven.mount")
    media = MOUNT / "baza"
    if not media.is_dir():
        raise RuntimeError("The selected media folder is missing: " + str(media))
    for directory in (HOME / ".local", HOME / ".local/share", DATA):
        directory.mkdir(exist_ok=True)
        os.chown(directory, USER.pw_uid, USER.pw_gid)
    DATA.chmod(0o700)
    state = DATA / "state.json"
    if not state.exists():
        payload = json.loads((REPO / "data/state.json").read_text())
        payload["mediaDirectory"] = str(media)
        write_user(state, json.dumps(payload, indent=2) + "\n")
    unit = Path("/etc/systemd/system/edging-heaven.service")
    backup(unit)
    shutil.copyfile(REPO / "deploy/edging-heaven.service", unit)
    unit.chmod(0o644)
    run("systemctl", "daemon-reload")
    run("systemctl", "enable", "edging-heaven.service")
    run("systemctl", "restart", "edging-heaven.service")
    for attempt in range(30):
        try:
            with urllib.request.urlopen("http://127.0.0.1:8420/api/state", timeout=10) as response:
                payload = json.load(response)
            break
        except (OSError, TimeoutError):
            if attempt == 29:
                raise
            time.sleep(1)
    if not payload["libraryReady"]:
        raise RuntimeError("Service started, but the saved media folder is unavailable: " + str(payload["mediaDirectory"]))
    user_run("tailscale", "serve", "--bg", "--https=8446", "http://127.0.0.1:8420")
    homepage = HOME / "homepage/index.html"
    html = homepage.read_text()
    if URL not in html:
        html = html.replace("</main>", '  <a class="card" href="' + URL + '/">\n    <span class="name">Edging Heaven</span>\n    <span class="desc">photos and videos from Lexar</span>\n  </a>\n</main>')
        write_user(homepage, html, 0o644)
    hosting = HOME / "infomds/HOSTING.md"
    text = hosting.read_text()
    for count in ("Three", "Four", "Five"):
        text = text.replace(count + " apps served over Tailscale", "Apps served over Tailscale")
    if URL not in text:
        row = f"| `{URL}` | Edging Heaven | 8420 | `edging-heaven.service` |\n"
        text = text.replace("\nUnits:", "\n" + row + "\nUnits:")
        text += "\nEdging Heaven: `/etc/systemd/system/edging-heaven.service`, enabled at boot.\nLexar auto-mount and full setup/undo instructions: `/home/qwerty/infomds/EDGING-HEAVEN.md`.\n"
    # Preserve the existing Nextcloud mapping and make the map reflect it.
    if "https://qwertyserver.tailc27f97.ts.net:8445`" not in text and any(host.endswith(":8445") for host in serve.get("Web", {})):
        text = text.replace("\nUnits:", "\n| `https://qwertyserver.tailc27f97.ts.net:8445` | Nextcloud | 8081 | Docker / Tailscale Serve |\n\nUnits:")
    write_user(hosting, text.replace("|\n\n|", "|\n|"), 0o644)
    contents = DOC.read_text().replace("**Status: prepared; administrator installation has not run yet.**", "**Status: installed. Local HTTP and media scan verified; remote HTTPS verification follows separately.**")
    contents += "\n## Installed library\n\nSelected folder: `" + payload["mediaDirectory"] + "`.\n"
    write_user(DOC, contents, 0o644)
    print("Ready: " + URL)
    print("Media folder: " + payload["mediaDirectory"])
    print("Images: " + str(payload["library"]["counts"]["images"]) + "; videos: " + str(payload["library"]["counts"]["videos"]))
    print("Documentation: " + str(DOC))


if __name__ == "__main__":
    main()
