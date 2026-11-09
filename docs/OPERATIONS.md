# Operating CallLive 15.0.10

The [module manual](../calllive/README.md) describes the AMI account, storage, permissions and quality score.

## Upgrade a running PBX

1. Check the current module and collector versions in **Reports → Call Monitor → Diagnostics**. Back up the PBX, including `/var/lib/freepbx-calllive` and the local signing files under `/etc/freepbx.secure`. Keep the previous installation package and signing command.
2. Upload the [English 15.0.10 archive](../dist/15.0.10/freepbx15-calllive-en-15.0.10.tar.gz) in **Module Admin**. Select **Call Monitor → Upgrade → Process → Confirm**.
3. Paste the full [local signing command](../dist/15.0.10/calllive-15.0.10-sign-root-command.txt) into a root shell. After verification succeeds, select **Apply Config**.
4. If collector **15.0.8** is running and history is available, check the dashboard. For initial setup or an older collector, run the [collector setup command](../dist/15.0.10/calllive-15.0.10-update-root-command.txt) as root. For a standard installation use the following command.

   ```bash
   bash /var/www/html/admin/modules/calllive/deploy/update-root.sh
   ```

5. Confirm **Module 15.0.10**, **Collector 15.0.8** and **Collector is compatible** in **Diagnostics**. Place a test call and reopen it from **History**. Select a timeline event to verify its chart marker.

## Collector backup and rollback

Collector setup creates a root-only backup under `/var/backups/freepbx-calllive`. The printed rollback command contains the exact directory to use. Backup files can contain AMI credentials.

```bash
bash /var/www/html/admin/modules/calllive/deploy/update-root.sh --rollback /var/backups/freepbx-calllive/BACKUP_DIRECTORY
```

The setup script checks for a new, healthy snapshot after starting the service. On a startup or readiness failure it attempts to restore the previous files and service state. If restoration is incomplete, check its output and the service log. Call history is stored separately. Use the PBX backup to restore the web module and its matching signature if needed.

## User access

In **Admin → User Management → Users → Administration GUI**, allow the admin login, set **Grant Full Administration Rights → No**, and grant **Call Monitor**. This permission gives access to PBX-wide current and archived calls. Full administrators can change shared thresholds. The setup and signing commands require a root shell.

## Service checks

```bash
systemctl status freepbx-calllive.service --no-pager -l
journalctl -u freepbx-calllive.service -n 50 --no-pager
systemctl cat freepbx-calllive.service
```

Check free space and group permissions on `/var/lib/freepbx-calllive` when Diagnostics reports a history write error. Diagnostics also reports retention, capacity and skipped records.

## Local signature

The [PHP CLI script](../dist/15.0.10/calllive-15.0.10-sign-local.php) and [root command](../dist/15.0.10/calllive-15.0.10-sign-root-command.txt) contain the same code. They verify installed files, sign the module with the PBX local key and check the result through FreePBX. The private key stays on the PBX.

Keep temporary files and Python bytecode outside the installed module directory. The release checker verifies the complete file list. Runtime files are stored separately under `/opt/freepbx-calllive` and `/var/lib/freepbx-calllive`.
