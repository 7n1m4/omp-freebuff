#!/usr/bin/env bash
# Registers/unregisters the daily Freebuff streak Keeper schedule (ADR-0002).
# 21:00 local = 18:00 UTC for TRT, which has no DST; the freebuff daily
# allowance resets at 21:00 UTC.
#
# The Linux counterpart of the Windows Task Scheduler entry the PS1 registers:
#   register-keeper-task.ps1 -> Register-ScheduledTask -Daily -At '21:00'
#                               -StartWhenAvailable -WhatIf:$WhatIfPreference
#
# Schedule mechanism: a per-user systemd timer, which is the native Linux
# equivalent of a personal scheduled task — no root, no global state, and
# -StartWhenAvailable maps onto the timer's Persistent= true. cron is not used
# because it has no start-when-available concept: a missed slot would be lost,
# and a plain one-off timer loses the schedule across reboots.
#
# Usage:
#   scripts/register-keeper-task.sh              # register
#   scripts/register-keeper-task.sh --unregister # remove
#   scripts/register-keeper-task.sh --dry-run    # print what would change
set -euo pipefail

UNREGISTER=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --unregister) UNREGISTER=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      # Every leading comment line except the shebang, comment markers stripped.
      tail -n +2 "$0" | sed -n 's/^# \{0,1\}\(.*\)$/\1/p' | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}'
      exit 0
      ;;
    *)
      echo "unknown option: $arg" >&2
      echo "usage: $0 [--unregister] [--dry-run]" >&2
      exit 2
      ;;
  esac
done

TASK_NAME="freebuff-streak-keeper"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# systemd reads this file directly, so it must be an absolute path.
UNIT_PATH="$HOME/.config/systemd/user/${TASK_NAME}.timer"
SERVICE_PATH="$HOME/.config/systemd/user/${TASK_NAME}.service"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[dry-run] would write $UNIT_PATH:"
  cat <<'EOF'
[Unit]
Description=Freebuff Streak Keeper daily schedule

[Timer]
OnCalendar=*-*-* 21:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
  echo "[dry-run] would write $SERVICE_PATH:"
  cat <<EOF
[Unit]
Description=Freebuff Streak Keeper

[Service]
Type=oneshot
WorkingDirectory=${REPO_ROOT}
ExecStart=$(command -v bun) scripts/keeper.ts
EOF
  if [ "$UNREGISTER" -eq 1 ]; then
    echo "[dry-run] would run: systemctl --user disable --now ${TASK_NAME}.timer"
  else
    echo "[dry-run] would run: systemctl --user daemon-reload && systemctl --user enable --now ${TASK_NAME}.timer"
  fi
  exit 0
fi

if [ "$UNREGISTER" -eq 1 ]; then
  systemctl --user disable --now "${TASK_NAME}.timer" 2>/dev/null || true
  rm -f "$UNIT_PATH" "$SERVICE_PATH"
  systemctl --user daemon-reload
  echo "removed '$TASK_NAME'"
  exit 0
fi

BUN_BIN="$(command -v bun || true)"
if [ -z "$BUN_BIN" ]; then
  echo "bun not found on PATH; the Keeper runs under bun" >&2
  exit 1
fi

mkdir -p "$HOME/.config/systemd/user"
cat >"$SERVICE_PATH" <<EOF
[Unit]
Description=Freebuff Streak Keeper

[Service]
Type=oneshot
WorkingDirectory=${REPO_ROOT}
ExecStart=${BUN_BIN} scripts/keeper.ts
EOF
cat >"$UNIT_PATH" <<EOF
[Unit]
Description=Freebuff Streak Keeper daily schedule

[Timer]
OnCalendar=*-*-* 21:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now "${TASK_NAME}.timer"
echo "registered '$TASK_NAME': daily 21:00, bun scripts/keeper.ts in $REPO_ROOT"
echo "next run: $(systemctl --user list-timers "$TASK_NAME.timer" --no-legend | awk '{print $1, $2, $3}')"
