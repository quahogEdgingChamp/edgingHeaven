#!/usr/bin/env bash
# Replaces the dead Lexar flash drive with a 200 GiB space on the SSD and
# resets Edging Heaven to an empty library.
#
#   sudo bash /home/qwerty/git/edgingHeaven/deploy/move-library-to-ssd.sh
#
# The space is a file (/srv/edging-heaven.img) formatted as its own ext4
# filesystem and loop-mounted at /srv/edging-heaven. Being its own filesystem
# is what makes simp's 3 GiB reserve (min_free_bytes) mean "3 GiB of these
# 200", not "3 GiB of the whole SSD".
#   /srv/edging-heaven/media/                 the library, one folder per model
#   /srv/edging-heaven/.media.simp-incoming/  simp's staging (must be on the same
#                                             filesystem but outside the library)
#   /home/qwerty/edging-heaven -> /srv/edging-heaven/media   (easy-to-find shortcut)
# Notes: ~/infomds/EDGING-HEAVEN.md
set -euo pipefail

OWNER=qwerty
IMAGE=/srv/edging-heaven.img
SIZE=200G
SPACE=/srv/edging-heaven
LIBRARY=$SPACE/media
SHORTCUT=/home/qwerty/edging-heaven
DATA=/home/qwerty/.local/share/edging-heaven
OLD_MOUNT=/mnt/edging-heaven
OLD_UUID=46C6-231E
UNIT=edging-heaven.service
DROPIN=/etc/systemd/system/edging-heaven.service.d/storage.conf

[[ $EUID -eq 0 ]] || { echo "Run with sudo."; exit 1; }
[[ ! -e $IMAGE ]] || { echo "$IMAGE already exists; refusing to overwrite it."; exit 1; }
if mountpoint -q "$SPACE"; then echo "$SPACE is already a mount; stopping."; exit 1; fi
[[ ! -e $SHORTCUT && ! -L $SHORTCUT ]] || { echo "$SHORTCUT already exists; stopping."; exit 1; }
free=$(df --output=avail -B1 /srv 2>/dev/null || df --output=avail -B1 / ); free=$(tail -1 <<<"$free")
(( free > 210 * 1024**3 )) || { echo "Less than 210 GiB free on the SSD; stopping."; exit 1; }

echo "== 1/8 Stop Edging Heaven"
systemctl stop "$UNIT"

echo "== 2/8 Release the old Lexar mount (the stick is unplugged)"
systemctl stop 'mnt-edging\x2dheaven.automount' 'mnt-edging\x2dheaven.mount' 2>/dev/null || true
for _ in 1 2 3; do mountpoint -q "$OLD_MOUNT" && umount -l "$OLD_MOUNT" || true; done

echo "== 3/8 /etc/fstab: retire the Lexar line, add the SSD image"
[[ -e /etc/fstab.before-ssd ]] || cp -a /etc/fstab /etc/fstab.before-ssd
sed -i -e "/^UUID=$OLD_UUID[[:space:]]/s|^|# Lexar flash drive, dead since 2026-09-29: |" \
       -e "/^# Edging Heaven: Lexar, read-only, mount on access$/d" /etc/fstab
if ! grep -q "^$IMAGE[[:space:]]" /etc/fstab; then
    printf '%s\n' \
        "# Edging Heaven library: 200 GiB ext4 filesystem in a file on the SSD (~/infomds/EDGING-HEAVEN.md)" \
        "$IMAGE $SPACE ext4 loop,nosuid,nodev,noexec,nofail,X-fstrim.notrim 0 2" >> /etc/fstab
fi
systemctl daemon-reload

echo "== 4/8 Create the 200 GiB space"
mkdir -p /srv
fallocate -l "$SIZE" "$IMAGE"          # reserves all 200 GiB on the SSD now
chmod 600 "$IMAGE"
# -E nodiscard: mkfs would otherwise "discard" the empty filesystem, which on a
# loop file punches holes and silently gives the 200 GiB back to the SSD.
# -m 0: no 5% root reserve; simp keeps its own 3 GiB free.
mkfs.ext4 -q -F -m 0 -E nodiscard -L edging-heaven "$IMAGE"

echo "== 5/8 Mount it at $SPACE, shortcut at $SHORTCUT"
install -d -m 755 "$SPACE"
mount "$SPACE"                          # uses the fstab line, so this also tests it
chown "$OWNER:$OWNER" "$SPACE"
chmod 700 "$SPACE"
install -d -o "$OWNER" -g "$OWNER" -m 700 "$LIBRARY"
runuser -u "$OWNER" -- ln -s "$LIBRARY" "$SHORTCUT"
rmdir "$OLD_MOUNT" 2>/dev/null || true

echo "== 6/8 Service drop-in: wait for the mount, allow writes to it"
mkdir -p "$(dirname "$DROPIN")"
cat > "$DROPIN" <<EOF
# The library is the SSD image mounted at $SPACE (see /etc/fstab).
# RequiresMountsFor: start only after it is mounted, and never without it,
# so simp can never download into the bare folder on the root filesystem.
# ReadWritePaths: explicit write access to the space (the unit's other
# protections stay as they are).
[Unit]
RequiresMountsFor=$SPACE

[Service]
ReadWritePaths=$SPACE
EOF
systemctl daemon-reload

echo "== 7/8 Reset Edging Heaven and simp to zero"
runuser -u "$OWNER" -- env DATA="$DATA" LIBRARY="$LIBRARY" python3 - <<'EOF'
import json, os, re, shutil
from pathlib import Path

os.umask(0o077)  # rewritten files stay private (600), like the originals
data = Path(os.environ["DATA"]); library = os.environ["LIBRARY"]
simp = data / "scrprsimp"

def write_json(path, value):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(value, indent=2), encoding="utf-8")
    tmp.replace(path)

state = json.loads((data / "state.json").read_text(encoding="utf-8"))
for key in ("ratings", "ratingTimes", "dangerousKept", "duel", "marks", "lockTokens"):
    state[key] = {}
for key in ("sessions", "brokenPaths"):
    state[key] = []
for key, value in state.get("settings", {}).items():
    if key.endswith("Folders") and isinstance(value, list) or key == "folderSets":
        state["settings"][key] = []
state["mediaDirectory"] = library
write_json(data / "state.json", state)

for name in ("seen.json", "fingerprints.json", "dangerous-kept-import.json.imported",
             "state.json.before-rating-reset-2026-09-27"):
    (data / name).unlink(missing_ok=True)
shutil.rmtree(data / "thumbs", ignore_errors=True)

for sub in ("reports", "jobs", "state/crawl", "state/done", "state/failed", "state/cdl"):
    shutil.rmtree(simp / sub, ignore_errors=True)
if simp.is_dir():
    (simp / "jobs").mkdir(mode=0o700)

# simp's files exist only if its folder was set up or restored; skip what is missing.
bookmarks_path = simp / "state/bookmarks.json"
if bookmarks_path.exists():
    bookmarks = json.loads(bookmarks_path.read_text(encoding="utf-8"))
    for item in bookmarks.get("bookmarks", []):
        item["downloaded"] = False
    write_json(bookmarks_path, bookmarks)

if simp.is_dir():
    (simp / "whereto.txt").write_text(
        "# Where simp saves media: the Edging Heaven library, a 200 GiB space on the SSD.\n"
        "# Each model lands in <this path>/<model>/ (models_subdir = \"\" in config.toml).\n"
        f"{library}\n", encoding="utf-8")

config = simp / "config.toml"
if config.exists():
    text = config.read_text(encoding="utf-8")
    text = text.replace("# FAT32 cannot hold a file of 4 GiB or more: use 4294967295 there.\n",
                        "# The library is ext4 now (no FAT32 4 GiB limit), so no cap.\n")
    text = re.sub(r"(?m)^max_file_bytes = \d+$", "max_file_bytes = 0", text)
    config.write_text(text, encoding="utf-8")
print("   app state reset; mediaDirectory =", library)
EOF

echo "== 8/8 Start and check"
echo "   image uses $(du -h "$IMAGE" | cut -f1) on the SSD (should be ~200G)"
systemctl start "$UNIT"
sleep 3
systemctl is-active "$UNIT"
findmnt "$SPACE"
df -h "$SPACE"
ls -ld "$SHORTCUT"
curl -fsS http://127.0.0.1:8420/api/state | python3 -c \
    'import json,sys; d=json.load(sys.stdin); print("   API mediaDirectory:", d.get("mediaDirectory"))'
echo "Done."
