#!/system/bin/sh
# Read-only local data staging. Runs on the device as root.
#
# Assumes a working root shell already exists (a `su` binary). It does not obtain root,
# does not call any system or vendor service, and does not write to any app data. It only
# copies FROM app data INTO its own staging dir and hashes what it copied. Read-only on
# everything but the staging dir.
#
# Usage (device connected over adb):
#   adb push stack.sh /data/local/tmp/
#   adb shell "su -c 'sh /data/local/tmp/stack.sh'"
#   adb pull /data/local/tmp/out ./out
#   python3 stack.py ./out
#
# Options (env vars):
#   OUT_DIR=/path     staging dir (default /data/local/tmp/out)
#   WITH_MEDIA=1      also tar /data/media/0 (large; off by default)

set -u
STAGE="${OUT_DIR:-/data/local/tmp/out}"
MANIFEST="$STAGE/manifest.tsv"
LOG="$STAGE/run.log"
PKGXML="/data/system/packages.xml"
D=/data/data

log() { echo "$*"; echo "$*" >> "$LOG" 2>/dev/null; }

if [ "$(id -u 2>/dev/null)" != "0" ]; then
  echo "not root. run through your root shell:  su -c 'sh $0'"
  exit 1
fi

rm -rf "$STAGE"; mkdir -p "$STAGE"; : > "$LOG"
printf 'source\tstaged\tbytes\tsha256\ttype\n' > "$MANIFEST"
log "run $(date 2>/dev/null)"
log "staging: $STAGE"

sha()     { sha256sum "$1" 2>/dev/null | awk '{print $1}'; }
bytesof() { stat -c %s "$1" 2>/dev/null || wc -c < "$1" 2>/dev/null | tr -d ' '; }
classify() {
  m=$(head -c 15 "$1" 2>/dev/null)
  if [ "$m" = "SQLite format 3" ]; then echo "sqlite-plain"; else echo "encrypted-or-other"; fi
}

stage_file() {
  src="$1"; rel="$2"
  if [ ! -e "$src" ]; then log "  MISSING  $src"; return; fi
  if [ ! -f "$src" ]; then return; fi
  dst="$STAGE/$rel"; mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst" 2>>"$LOG" || { log "  COPYFAIL $src"; return; }
  b=$(bytesof "$dst"); h=$(sha "$dst"); t=$(classify "$dst")
  printf '%s\t%s\t%s\t%s\t%s\n' "$src" "$rel" "$b" "$h" "$t" >> "$MANIFEST"
  log "  staged   $rel  ${b}B  $t"
}

stage_db() {
  src="$1"; reldir="$2"; base=$(basename "$src")
  stage_file "$src" "$reldir/$base"
  [ -e "${src}-wal" ] && stage_file "${src}-wal" "$reldir/${base}-wal"
  [ -e "${src}-shm" ] && stage_file "${src}-shm" "$reldir/${base}-shm"
  return 0
}

stage_dir() {
  src="$1"; reldir="$2"
  if [ ! -d "$src" ]; then log "  MISSING  $src (dir)"; return; fi
  find "$src" -type f 2>/dev/null | while IFS= read -r f; do
    stage_file "$f" "$reldir/${f#$src/}"
  done
}

pkgver() {
  pkg="$1"
  line=$(grep -o "<package name=\"$pkg\"[^>]*" "$PKGXML" 2>/dev/null | head -1)
  [ -n "$line" ] && log "  version  $pkg :: $line" || log "  version  $pkg :: (not in packages.xml)"
}

for pkg in com.whatsapp com.whatsapp.w4b; do
  log "== $pkg =="; pkgver "$pkg"
  stage_file "$D/$pkg/files/key"                  "$pkg/files/key"
  stage_file "$D/$pkg/files/encrypted_backup.key" "$pkg/files/encrypted_backup.key"
  stage_db   "$D/$pkg/databases/msgstore.db"      "$pkg/databases"
  stage_db   "$D/$pkg/databases/wa.db"            "$pkg/databases"
done

log "== org.telegram.messenger =="; pkgver org.telegram.messenger
find "$D/org.telegram.messenger" -type f -name 'cache4.db' 2>/dev/null | while IFS= read -r f; do
  reldir="org.telegram.messenger/$(dirname "${f#$D/org.telegram.messenger/}")"
  stage_db "$f" "$reldir"
done

log "== jp.naver.line.android =="; pkgver jp.naver.line.android
stage_db  "$D/jp.naver.line.android/databases/naver_line" "jp.naver.line.android/databases"
stage_dir "$D/jp.naver.line.android/shared_prefs"         "jp.naver.line.android/shared_prefs"

log "== com.android.providers.telephony =="
stage_db "$D/com.android.providers.telephony/databases/mmssms.db" "com.android.providers.telephony/databases"

log "== com.android.providers.contacts =="
stage_db "$D/com.android.providers.contacts/databases/contacts2.db" "com.android.providers.contacts/databases"

log "== /data/media/0 =="
if [ -d /data/media/0 ]; then
  kb=$(du -sk /data/media/0 2>/dev/null | awk '{print $1}')
  cnt=$(find /data/media/0 -type f 2>/dev/null | wc -l | tr -d ' ')
  log "  inventory: ${kb}KB across ${cnt} files"
  printf '%s\t%s\t%s\t%s\t%s\n' "/data/media/0" "(media)" "${kb}KB" "${cnt}files" "inventory-only" >> "$MANIFEST"
  if [ "${WITH_MEDIA:-0}" = "1" ]; then
    log "  WITH_MEDIA=1: taring (large)..."
    tar -c -f "$STAGE/media.tar" -C /data/media 0 2>>"$LOG" && log "  media.tar done" || log "  media.tar FAILED"
  else
    log "  skipped (set WITH_MEDIA=1 to tar it)"
  fi
fi

rows=$(( $(wc -l < "$MANIFEST") - 1 ))
kb=$(du -sk "$STAGE" 2>/dev/null | awk '{print $1}')
log "DONE: $rows manifest rows, ${kb}KB staged in $STAGE"
log "Next: adb pull $STAGE ./out  &&  python3 stack.py ./out"
