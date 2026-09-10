# Edging Heaven on qwertyserver

**Status: prepared; administrator installation has not run yet.**

## What this is

A Python photo/video browser served privately through Tailscale. Media stays on
the Lexar USB drive plugged into the mini PC; ratings and settings stay on its SSD.

| Item | Value |
|---|---|
| Browser URL | `https://qwertyserver.tailc27f97.ts.net:8446` |
| Local server | `http://127.0.0.1:8420` |
| Service | `edging-heaven.service` |
| Flash drive | Lexar, 116.1 GiB, FAT32 (`vfat`) |
| Filesystem UUID | `46C6-231E` |
| Stable mount | `/mnt/edging-heaven` |
| Selected library | `/mnt/edging-heaven/baza` |
| App state | `/home/qwerty/.local/share/edging-heaven/state.json` |

Connect your phone/computer to the same Tailscale account, then open the URL.
The mini PC must be awake, online, and have the drive plugged in. No router port
forward is needed. This is Tailscale Serve, which is private to the tailnet.
Anyone your Tailscale access policy allows to reach this service can use the app;
the app has no separate login.

## Why this approach

| Choice | Reason and tradeoff |
|---|---|
| Existing Python + systemd | No new packages or containers. A systemd unit starts the process at boot and restarts it after a crash. It runs as `qwerty`, without requiring a login session. |
| Bind to `127.0.0.1` | Only local processes can connect directly. Tailscale handles encrypted remote access. |
| Serve on HTTPS port 8446 | Existing apps already use 443, 8443, 8444, 8445, and 10000. A dedicated port avoids path-prefix routing issues. |
| UUID mount | `/dev/sda1` can change when other disks are connected. UUID identifies this filesystem across USB ports and reboots. Reformatting changes the UUID. |
| Read-only drive | Browsing needs no writes to USB. Ratings live on the SSD, so the app cannot alter drive contents. To add media, use another computer or deliberately remount it for writing. |
| systemd automount | An access to the fixed folder mounts the drive. No desktop login or manual mount command is needed. A missing USB drive does not block boot. |
| App availability checks | A visible browser page checks about every 5 seconds. The server rescans when the saved folder disappears or returns. It does not repeatedly scan a connected library or interrupt playback on every check. |

## Files changed

| Path | Purpose |
|---|---|
| `/etc/fstab` | One UUID entry for the Lexar automount |
| `/etc/fstab.before-edging-heaven` | Original fstab backup; created only once |
| `/mnt/edging-heaven` | Mount directory |
| `/etc/systemd/system/edging-heaven.service` | Enabled app service |
| `/etc/systemd/system/multi-user.target.wants/edging-heaven.service` | Enable-at-boot symlink managed by systemctl |
| `/home/qwerty/.local/share/edging-heaven/` | Private writable state directory, mode 0700 |
| `/home/qwerty/.local/share/edging-heaven/state.json` | Initial copy of repository state, with the media path changed to the mounted drive; subsequent installer runs preserve it |
| `/home/qwerty/homepage/index.html` | Adds the app link |
| `/home/qwerty/infomds/HOSTING.md` | Adds this app and records the existing Nextcloud port |
| `/home/qwerty/infomds/EDGING-HEAVEN.md` | This reference |
| `/home/qwerty/git/edgingHeaven/server.py` | Saved-folder reconnect detection, Linux drive suggestions, startup with an absent drive |
| `/home/qwerty/git/edgingHeaven/static/app.js` | Checks library availability and refreshes on a connection change |
| `/home/qwerty/git/edgingHeaven/README.md` | Documents reconnect behavior |
| `/home/qwerty/git/edgingHeaven/tests/test_drive_reconnect.py` | Reconnect, restart, ratings, and rescan checks |
| `/home/qwerty/git/edgingHeaven/deploy/edging-heaven.service` | Source copy of the systemd unit |
| `/home/qwerty/git/edgingHeaven/deploy/install-qwertyserver.py` | Repeatable installer for this machine and drive |
| `/home/qwerty/git/edgingHeaven/deploy/EDGING-HEAVEN.md` | Installation guide template |

No packages installed. Tailscale Serve stores the additional mapping in its own
daemon-managed state; do not edit that state by hand. `--bg` persists the mapping
through logout and reboot. The app service is separately enabled through systemd.

The fstab generator creates `mnt-edging\x2dheaven.automount` and
`mnt-edging\x2dheaven.mount` under `/run/systemd/generator/` at boot or
`daemon-reload`. Those are generated files, not files to edit.

## Reproduce the installation

These commands assume this repository, including the deployment files and app
changes, exists at `/home/qwerty/git/edgingHeaven`, the user is `qwerty`, and
Tailscale is already signed in. The installer is specific to this server.

```bash
# Plug the Lexar into the mini PC, then confirm the UUID.
lsblk -o NAME,TRAN,SIZE,FSTYPE,LABEL,UUID,MOUNTPOINTS
PYTHONPATH=/home/qwerty/git/edgingHeaven python3 -m unittest discover -s /home/qwerty/git/edgingHeaven/tests -v
sudo python3 /home/qwerty/git/edgingHeaven/deploy/install-qwertyserver.py
```

The installer backs up fstab, adds this entry (UID/GID obtained from the qwerty
account), starts the mount, seeds app state, installs/enables the service, checks
local HTTP and media availability, adds Serve, then updates the homepage and map.
It refuses a conflicting mount or port assignment. On failure, it records the
error here; completed steps remain in place so rerunning can finish them.

```fstab
UUID=46C6-231E /mnt/edging-heaven vfat ro,nosuid,nodev,noexec,uid=1000,gid=1000,umask=0077,nofail,x-systemd.automount,x-systemd.device-timeout=2s,x-systemd.mount-timeout=10s 0 0
```

`ro` forbids writes. `uid`, `gid`, and `umask` make FAT files readable only to
qwerty (and root); FAT does not store Unix ownership. `nodev`, `nosuid`, and
`noexec` prevent treating USB contents as device nodes or executable programs.
`nofail` allows boot without the drive. The two-second device timeout keeps a
missing drive from holding a request for the default long timeout.

The main service commands used by the installer are:

```bash
sudo systemctl daemon-reload
sudo systemctl start 'mnt-edging\x2dheaven.automount'
sudo systemctl start 'mnt-edging\x2dheaven.mount'
sudo install -m 0644 /home/qwerty/git/edgingHeaven/deploy/edging-heaven.service /etc/systemd/system/edging-heaven.service
sudo systemctl daemon-reload
sudo systemctl enable edging-heaven.service
sudo systemctl restart edging-heaven.service
tailscale serve --bg --https=8446 http://127.0.0.1:8420
```

## Check it is alive

```bash
systemctl is-enabled edging-heaven.service
systemctl status edging-heaven.service --no-pager
journalctl -u edging-heaven.service -n 50 --no-pager
systemctl status 'mnt-edging\x2dheaven.automount' 'mnt-edging\x2dheaven.mount' --no-pager
findmnt /mnt/edging-heaven
curl --fail http://127.0.0.1:8420/api/library-status
curl --fail https://qwertyserver.tailc27f97.ts.net:8446/api/library-status
tailscale serve status
ss -ltn 'sport = :8420'
```

Port 8420 must show `127.0.0.1`, not `0.0.0.0`. With the drive present,
`libraryReady` should be true. Without it, the page should show the saved path as
unavailable; the service itself should stay running.

After changing Python code, run `sudo systemctl restart edging-heaven.service`.
HTML/CSS/JS changes need a browser reload. New media added while the library
stays mounted needs the app's **Rescan Library** button. Reconnecting rescans
automatically. Very large libraries take longer than the five-second check.

For an actual remote test, turn Wi-Fi off on the phone, enable Tailscale, and open
the HTTPS URL over mobile data. A local HTTPS check does not prove this phone test.

## Disconnect and reconnect

The mount is read-only. For a clean removal, stop the mount and automount first:

```bash
sudo systemctl stop 'mnt-edging\x2dheaven.automount' 'mnt-edging\x2dheaven.mount'
# Physically unplug the drive now. Then re-arm automatic mounting:
sudo systemctl start 'mnt-edging\x2dheaven.automount'
```

Leave the app running. Plug the same drive back in: the open page will detect it
and reload the library. Reboot also re-arms the automount.

## Undo

```bash
tailscale serve --https=8446 off
sudo systemctl disable --now edging-heaven.service
sudo systemctl stop 'mnt-edging\x2dheaven.automount' 'mnt-edging\x2dheaven.mount'
sudoedit /etc/fstab
# Remove only the UUID=46C6-231E entry and its Edging Heaven comment, then save.
sudo rm /etc/systemd/system/edging-heaven.service
sudo systemctl daemon-reload
sudo rmdir /mnt/edging-heaven
```

Remove the Edging Heaven card from `/home/qwerty/homepage/index.html` and its row
and notes from `/home/qwerty/infomds/HOSTING.md`. Keep other app mappings intact;
do not use `tailscale serve reset`. Keep the SSD state directory if you want to
retain ratings. Delete it only if those ratings/settings are no longer wanted.
The flash drive is never formatted or erased by setup or undo.

## Gotchas

- Keep the flash drive attached to the server, not the remote phone or laptop.
- Reformatting or replacing it requires updating the UUID in fstab and installer.
- The installer selects the `baza` folder on Lexar. Use **Change Folder** to choose a different
  folder if needed. Switching paths clears ratings by existing app design.
- There is no video transcoding. Browser codec support still determines which
  videos play, and home upload speed limits streaming from outside.
- Live ratings/settings are outside Git. Never copy private state or USB media
  into a commit. The repository's original `data/state.json` remains a separate
  file; the installed service does not write to it.
- The service can start without the drive; the browser checks when visible. No
  browser open means no need to scan. A paused/background tab checks on returning.
- Backups named `.before-edging-heaven` preserve the first installation state.
  Do not restore them wholesale if those files have since gained other changes.
- The homepage and hosting map are edited in place; no backup copies are created for them.
- Reboot and physical USB replug tests require separate verification; the
  automated tests simulate the folder disappearing and returning.

References: [Tailscale Serve command](https://tailscale.com/docs/reference/tailscale-cli/serve)
and [systemd mount options](https://www.freedesktop.org/software/systemd/man/latest/systemd.mount.html).
