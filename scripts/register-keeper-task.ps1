# Registers/unregisters the daily Freebuff streak Keeper task (21:00 local =
# 18:00 UTC; the daily allowance resets at 21:00 UTC and TRT has no DST).
[CmdletBinding(SupportsShouldProcess)]
param([switch]$Unregister)

$ErrorActionPreference = 'Stop'
$taskName = 'Freebuff Streak Keeper'
$repoRoot = Split-Path $PSScriptRoot -Parent

if ($Unregister) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Output "removed '$taskName'"
    exit 0
}

$action = New-ScheduledTaskAction -Execute 'bun.exe' -Argument 'scripts\keeper.ts' -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -Daily -At '21:00'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable   # fires on next boot if 21:00 was missed
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force -WhatIf:$WhatIfPreference | Out-Null
Write-Output "registered '$taskName': daily 21:00, bun scripts\keeper.ts in $repoRoot"
