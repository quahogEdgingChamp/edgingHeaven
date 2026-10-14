#!/usr/bin/env bash
# Moves the Edging Heaven library from the 200 GiB image on the system SSD to a
# new disk (e.g. a bigger SATA SSD), keeping everything: ratings, Love, marks,
# duels, seen times, Dangerous keeps, the trash, and simp's memory of what was
# downloaded and deleted (so deleted files are never downloaded again).
#
# Why it is this simple: the new disk is mounted at the SAME place,
# /srv/edging-heaven, so the library stays /srv/edging-heaven/media. Every
# rating is stored relative to that folder, and simp's download memory lives on
# the system SSD (~/.local/share/edging-heaven/scrprsimp/state), not in the
# library. Nothing in the app or in simp has to change; only /etc/fstab does.
#
#   sudo bash deploy/move-library-to-new-disk.sh check          # what would happen; changes nothing
#   sudo bash deploy/move-library-to-new-disk.sh prepare /dev/sdX   # ERASES that disk, makes it ext4
#   sudo bash deploy/move-library-to-new-disk.sh move           # copy, switch over, start again
#   sudo bash deploy/move-library-to-new-disk.sh undo           # back to the image (until finish)
#   sudo bash deploy/move-library-to-new-disk.sh finish         # delete the old image: +200 GiB on /
#
# Notes: ~/infomds/EDGING-HEAVEN.md → "Moving the library to a new disk".
# NOT move-library-to-ssd.sh: that one resets everything to an empty library.
set -euo pipefail

OWNER=qwerty
SPACE=/srv/edging-heaven                 # the mount point; stays the same
LIBRARY=$SPACE/media
IMAGE=/srv/edging-heaven.img             # the old 200 GiB filesystem-in-a-file
LABEL=eh-library                         # filesystem label of the new disk
STAGE=/mnt/edging-heaven-new             # where the new disk sits while copying
DATA=/home/$OWNER/.local/share/edging-heaven
UNIT=edging-heaven.service
SNAPSHOTS=/home/$OWNER/edging-heaven-memory   # copies of the app's memory, before each move

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die()  { printf 'Stopped: %s\n' "$*" >&2; exit 1; }
need_root() { [[ $EUID -eq 0 ]] || die "run it with sudo."; }
confirm() {  # confirm "<what to type>" "<question>"
    local answer
    printf '%s\nType %s to go on: ' "$2" "$1"
    read -r answer
    [[ $answer == "$1" ]] || die "not confirmed; nothing more was changed."
}

new_part() { blkid -L "$LABEL" 2>/dev/null || true; }
space_source() { findmnt -no SOURCE "$SPACE" 2>/dev/null || true; }
on_image() { [[ "$(findmnt -no SOURCE "$SPACE" 2>/dev/null)" == /dev/loop* ]]; }
downloading() { pgrep -u "$OWNER" -f 'scrprsimp/\.venv/bin/(simp|cyberdrop)' >/dev/null; }
bytes() { numfmt --to=iec --suffix=B "$1"; }

cmd_check() {
    step "Where the library is now"
    findmnt "$SPACE" || say "  $SPACE is not mounted"
    df -h "$SPACE" 2>/dev/null | tail -1 || true
    local used
    used=$(du -sb --exclude=lost+found "$SPACE" 2>/dev/null | cut -f1 || echo 0)
    say "  to copy: $(bytes "${used:-0}") (media, the trash inside it, simp's staging folder)"

    step "What stays where it is (on the system SSD; the move does not touch it)"
    for f in state.json seen.json fingerprints.json watch.json duels.json thumbs \
             scrprsimp/state/done scrprsimp/state/cdl/cyberdrop.db scrprsimp/state/crawl scrprsimp/config.toml; do
        [[ -e $DATA/$f ]] && say "  $DATA/$f" || true
    done
    grep -q '^redownload_missing = false' "$DATA/scrprsimp/config.toml" 2>/dev/null \
        && say "  simp: redownload_missing = false (deleted files stay deleted)" \
        || say "  WARNING: simp's config.toml does not say redownload_missing = false"

    step "Disks"
    lsblk -o NAME,SIZE,TYPE,FSTYPE,LABEL,MOUNTPOINTS,MODEL,TRAN
    local part
    part=$(new_part)
    if [[ -n $part ]]; then
        say "  new disk prepared: $part (label $LABEL)"
    else
        say "  no disk prepared yet: plug it in, find it above (SIZE, MODEL, TRAN=sata), then: prepare /dev/sdX"
    fi

    step "Right now"
    systemctl is-active "$UNIT" >/dev/null && say "  $UNIT is running" || say "  $UNIT is stopped"
    downloading && say "  a download is running: let it finish or cancel it on the Downloads page first" \
                || say "  no download running"
    on_image && say "  the library is on the old image ($IMAGE)" || say "  the library is not on the image"
    [[ -e $IMAGE ]] && say "  old image present: $(du -h "$IMAGE" | cut -f1) on the system SSD" || true
}

cmd_prepare() {
    need_root
    local dev=${1:-}
    [[ -n $dev && -b $dev ]] || die "give the new disk, e.g. prepare /dev/sdb (see: check)."
    [[ "$(lsblk -dno TYPE "$dev")" == disk ]] || die "$dev is not a whole disk (give /dev/sdb, not /dev/sdb1)."
    # Anything on it in use (mounted, swap, LVM, the system) → refuse.
    if lsblk -nro MOUNTPOINTS "$dev" | grep -q .; then
        lsblk "$dev"; die "something on $dev is mounted. This is not an empty new disk."
    fi
    if lsblk -nro FSTYPE "$dev" | grep -Eq 'LVM2_member|crypto_LUKS|swap|linux_raid_member'; then
        lsblk -o NAME,FSTYPE "$dev"; die "$dev holds LVM/encryption/swap/RAID. Not touching it."
    fi
    [[ -z $(new_part) ]] || die "a disk labelled $LABEL already exists ($(new_part)). Use move, or relabel it first."
    local size used
    size=$(lsblk -bdno SIZE "$dev")
    used=$(du -sb --exclude=lost+found "$SPACE" | cut -f1)
    (( size > used + 10 * 1024**3 )) || die "$dev ($(bytes "$size")) is too small for $(bytes "$used") plus room."

    step "This disk will be ERASED"
    lsblk -o NAME,SIZE,FSTYPE,LABEL,MODEL,SERIAL,TRAN "$dev"
    confirm "$dev" "Everything on $dev ($(bytes "$size"), $(lsblk -dno MODEL "$dev")) is erased."

    step "Partition (one partition, GPT) and format (ext4, label $LABEL)"
    wipefs -a "$dev"
    printf 'label: gpt\n,,L\n' | sfdisk --quiet "$dev"
    partprobe "$dev" 2>/dev/null || true
    udevadm settle
    local part
    part=$(lsblk -nrpo NAME,TYPE "$dev" | awk '$2 == "part" {print $1; exit}')
    [[ -b $part ]] || die "the new partition did not show up; run prepare again."
    # -m 0: no 5% root reserve; simp keeps its own 3 GiB free on this disk.
    mkfs.ext4 -q -F -m 0 -L "$LABEL" "$part"
    udevadm settle
    say "  ready: $part, UUID $(blkid -s UUID -o value "$part"). Next: move"
}

mount_stage() {
    local part=$1
    install -d -m 755 "$STAGE"
    mountpoint -q "$STAGE" || mount -o nosuid,nodev,noexec "$part" "$STAGE"
    chown "$OWNER:$OWNER" "$STAGE"
    chmod 700 "$STAGE"
}

copy_pass() {
    # -a: owners, permissions and exact times (ratings are keyed by path; video
    # stills and fingerprints also by time). -H hard links, -A ACLs, -X xattrs.
    rsync -aHAX --numeric-ids --delete --info=progress2 --exclude=/lost+found "$SPACE/" "$STAGE/"
}

cmd_move() {
    need_root
    local part
    part=$(new_part)
    [[ -n $part ]] || die "no disk labelled $LABEL. Run prepare /dev/sdX first."
    on_image || die "the library is not on the image now ($(space_source)); already moved?"
    downloading && die "a download is running. Let it finish, or cancel it on the Downloads page, then run move again."
    local used avail
    used=$(du -sb --exclude=lost+found "$SPACE" | cut -f1)
    mount_stage "$part"
    avail=$(df --output=avail -B1 "$STAGE" | tail -1)
    (( avail > used )) || die "the new disk has $(bytes "$avail") free, the library needs $(bytes "$used")."
    confirm move "Copy $(bytes "$used") to $part, then switch the library over to it (the app is offline for the last part)."

    step "1/5 First copy, while the app keeps running (can take a while; safe to re-run)"
    copy_pass

    step "2/5 Stop the app; copy what changed meanwhile"
    # Stopping the app ends any download it runs, so look first.
    downloading && die "a download started during the copy. Run move again when it is done (the copy so far is kept)."
    systemctl stop "$UNIT"
    copy_pass

    step "3/5 Check the copy"
    local diff
    diff=$(rsync -aHAXn --numeric-ids --delete --itemize-changes --exclude=/lost+found "$SPACE/" "$STAGE/")
    if [[ -n $diff ]]; then
        printf '%s\n' "$diff" | head -20
        systemctl start "$UNIT"
        die "the copy differs from the library (above). Nothing was switched; the app runs on the old image again."
    fi
    local a b
    a=$(find "$SPACE" -path "$SPACE/lost+found" -prune -o -type f -print | wc -l)
    b=$(find "$STAGE" -path "$STAGE/lost+found" -prune -o -type f -print | wc -l)
    [[ $a == "$b" ]] || { systemctl start "$UNIT"; die "file counts differ ($a vs $b). Nothing was switched."; }
    say "  identical: $a files"

    step "4/5 Save a copy of the app's memory (ratings, seen times, simp's download history)"
    install -d -o "$OWNER" -g "$OWNER" -m 700 "$SNAPSHOTS"
    local snap
    snap=$SNAPSHOTS/before-new-disk-$(date +%Y%m%d-%H%M).tar.gz
    tar -czf "$snap" -C "$(dirname "$DATA")" "$(basename "$DATA")"
    chown "$OWNER:$OWNER" "$snap"
    chmod 600 "$snap"
    say "  $snap ($(du -h "$snap" | cut -f1)); it holds the SimpCity login too: keep it private"

    step "5/5 Switch /srv/edging-heaven to the new disk"
    local uuid
    uuid=$(blkid -s UUID -o value "$part")
    umount "$STAGE"
    umount "$SPACE" || { systemctl start "$UNIT"; die "the image is busy (see: fuser -vm $SPACE). Nothing was switched."; }
    cp -a /etc/fstab "/etc/fstab.before-new-disk"
    # The image line stays, commented, so undo can bring it back.
    sed -i "s|^$IMAGE[[:space:]]|# old 200 GiB image, replaced by $LABEL: &|" /etc/fstab
    printf '%s\n' \
        "# Edging Heaven library: the new disk ($(lsblk -no SIZE "$part"), label $LABEL), see ~/infomds/EDGING-HEAVEN.md" \
        "UUID=$uuid $SPACE ext4 defaults,noatime,nosuid,nodev,noexec,nofail 0 2" >> /etc/fstab
    systemctl daemon-reload
    mount "$SPACE"        # uses the new fstab line, so this also tests it
    [[ "$(space_source)" == "$part" ]] || die "$SPACE is not on $part after mounting; check findmnt $SPACE, or run undo."
    systemctl start "$UNIT"
    sleep 3
    systemctl is-active "$UNIT"
    findmnt "$SPACE"
    df -h "$SPACE"
    say ""
    say "Done. Open the app and check a few models, Collection (your keeps) and Downloads."
    say "The old image is still there: 'undo' goes back to it, 'finish' deletes it."
}

cmd_undo() {
    need_root
    [[ -e /etc/fstab.before-new-disk ]] || die "no /etc/fstab.before-new-disk: move was not run, or finish already was."
    [[ -e $IMAGE ]] || die "$IMAGE is gone (finish was run); there is nothing to go back to."
    confirm undo "Go back to the old image. Files downloaded or deleted since the move are changed only on the new disk (ratings are kept either way)."
    systemctl stop "$UNIT"
    umount "$SPACE" 2>/dev/null || true
    cp -a /etc/fstab "/etc/fstab.after-new-disk"
    cp -a /etc/fstab.before-new-disk /etc/fstab
    systemctl daemon-reload
    mount "$SPACE"
    systemctl start "$UNIT"
    findmnt "$SPACE"
    say "Back on the image. The new disk is untouched (fstab with it saved as /etc/fstab.after-new-disk)."
}

cmd_finish() {
    need_root
    [[ "$(space_source)" == "$(new_part)" && -n $(new_part) ]] || die "the library is not on the new disk; nothing to finish."
    [[ -e $IMAGE ]] || die "$IMAGE is already gone."
    confirm finish "Delete $IMAGE ($(du -h "$IMAGE" | cut -f1)). After this there is no undo."
    rm -f "$IMAGE"
    sed -i "\|^# old 200 GiB image, replaced by $LABEL: |d" /etc/fstab
    rm -f /etc/fstab.before-new-disk
    rmdir "$STAGE" 2>/dev/null || true
    df -h /
    say "Done: the image is gone and the system SSD has the space back."
}

# Sourced (tests/test_move_library.sh): functions only.
[[ ${BASH_SOURCE[0]} == "$0" ]] || return 0

case ${1:-} in
    check)   cmd_check ;;
    prepare) cmd_prepare "${2:-}" ;;
    move)    cmd_move ;;
    undo)    cmd_undo ;;
    finish)  cmd_finish ;;
    *) sed -n '2,20p' "$0"; exit 2 ;;
esac
