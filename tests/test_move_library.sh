#!/usr/bin/env bash
# The parts of deploy/move-library-to-new-disk.sh that need no root: the two
# copy passes and the check that the copy is identical (hidden folders, the
# trash, simp's staging folder, exact times). Run: bash tests/test_move_library.sh
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
# shellcheck source=../deploy/move-library-to-new-disk.sh
source "$here/deploy/move-library-to-new-disk.sh"
SPACE=$tmp/old STAGE=$tmp/new
mkdir -p "$SPACE/media/model/sub" "$SPACE/media/.heaven-trash/t1/media" "$SPACE/.media.simp-incoming/model" "$SPACE/lost+found" "$STAGE"
echo photo > "$SPACE/media/model/sub/p.jpg"
echo trashed > "$SPACE/media/.heaven-trash/t1/media/x.jpg"
echo '{"path": "model/x.jpg"}' > "$SPACE/media/.heaven-trash/t1/record.json"
echo part > "$SPACE/.media.simp-incoming/model/v.mp4.part"
touch -d '2026-01-02 03:04:05.123456789' "$SPACE/media/model/sub/p.jpg"
echo junk > "$STAGE/stale.jpg"   # already on the new disk: removed by --delete

verify() { [[ -z $(rsync -aHAXn --numeric-ids --delete --itemize-changes --exclude=/lost+found "$SPACE/" "$STAGE/") ]]; }
copy_pass >/dev/null
verify || { echo "FAIL: copy differs"; exit 1; }
[[ ! -e $STAGE/stale.jpg && ! -e $STAGE/lost+found ]] || { echo "FAIL: stale files or lost+found copied"; exit 1; }
[[ $(stat -c %y "$STAGE/media/model/sub/p.jpg") == "$(stat -c %y "$SPACE/media/model/sub/p.jpg")" ]] \
    || { echo "FAIL: time not exact"; exit 1; }
[[ -f $STAGE/media/.heaven-trash/t1/record.json && -f $STAGE/.media.simp-incoming/model/v.mp4.part ]] \
    || { echo "FAIL: trash or staging missing"; exit 1; }
echo changed > "$SPACE/media/model/new.jpg"     # landed during the first pass
verify && { echo "FAIL: a change went unnoticed"; exit 1; }
copy_pass >/dev/null
verify || { echo "FAIL: second pass did not catch up"; exit 1; }
echo "ok: copy passes and verification"
