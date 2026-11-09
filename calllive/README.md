# CallLive 15.0.10 for FreePBX 15

**Reports → Call Monitor** shows active calls, trunks, extension states and call quality. Saved records remain available after hangup. Select an event in the timeline to mark its timestamp on the four quality charts.

## Requirements

- FreePBX **15 with Core** and its PHP CLI.
- Linux with **systemd**, Python **3.6 or later**, and local access to Asterisk AMI.
- Asterisk supplies RTP/RTCP measurements for supported SIP and PJSIP audio channels. Direct media can make measurements unavailable at the PBX.
- Off-hook state appears when the PBX receives an OffHook indication.

The collector uses the Python standard library. Module **15.0.10** works with collector **15.0.8**, including installations of the original CallLive edition.

## Install or upgrade

1. Back up the PBX before updating a production installation. Download the [15.0.10 package](https://github.com/shayena84-byte/freepbx-calllive-en/tree/main/dist/15.0.10).
2. Upload `freepbx15-calllive-en-15.0.10.tar.gz` in **Admin → Module Admin → Upload Module**. Select **Call Monitor → Install or Upgrade → Process → Confirm**.
3. Paste the complete `calllive-15.0.10-sign-root-command.txt` file into a root shell on the PBX. After the signature is valid, select **Apply Config**.
4. On a first installation or with an older collector, run the setup command in **Reports → Call Monitor → Diagnostics** as root. With the default FreePBX web root, use the command below.

   ```bash
   bash /var/www/html/admin/modules/calllive/deploy/update-root.sh
   ```

   The setup file supplied in the package also detects a custom `AMPWEBROOT`. With a running collector **15.0.8**, proceed directly to verification.

5. Confirm the versions, AMI state and history access in **Diagnostics**. Place a test call, hang up and reopen it in **History**.

### Collector setup and rollback

The root command verifies FreePBX, module checksums, Python and AMI. It uses the service interpreter when available, including `/usr/bin/python3.6`. It backs up collector files, the service unit, the environment and dedicated AMI configuration under `/var/backups/freepbx-calllive`. Existing AMI credentials, daily counters, history and systemd drop-ins are preserved. Setup waits for a fresh, healthy snapshot and attempts to restore the previous service files if setup fails.

For preflight only, run the command with `--check-only`.

```bash
bash /var/www/html/admin/modules/calllive/deploy/update-root.sh --check-only
```

To restore the collector, use the exact backup path printed by setup.

```bash
bash /var/www/html/admin/modules/calllive/deploy/update-root.sh --rollback /var/backups/freepbx-calllive/BACKUP_DIRECTORY
```

The collector rollback covers its files, unit and AMI configuration. Call history stays on disk. Restore the web module and its matching signature from the PBX backup if a module rollback is needed.

### AMI account

On first setup, CallLive creates an unprivileged service account and a dedicated local AMI account. The default port is 5038. Asterisk `manager.conf` must include `manager_custom.conf`, which in turn includes `manager_calllive.conf`.

Example `/etc/asterisk/manager_calllive.conf` for the dedicated account.

```ini
[freepbx-calllive]
secret = LOCAL_SECRET
deny = 0.0.0.0/0.0.0.0
permit = 127.0.0.1/255.255.255.255
read = call,agent
write = reporting
displayconnects = no
eventfilter = Event: (Newchannel|Newstate|NewCallerid|NewConnectedLine|Hangup|DialBegin|DialEnd|BridgeCreate|BridgeDestroy|BridgeEnter|BridgeLeave|BridgeMerge|ExtensionStatus|Hold|Unhold|ParkedCall|UnParkedCall|ParkedCallTimeOut|ParkedCallGiveUp|BlindTransfer|AttendedTransfer|QueueCallerJoin|QueueCallerLeave|AgentConnect|AgentComplete)
```

The `reporting` class permits AMI list actions. For a custom AMI account, configure the permissions and event filter in Asterisk and supply the actual account and port in `/etc/freepbx-calllive.env`. The environment file should be owned by root with mode `0600`.

```ini
CALLLIVE_AMI_USER=freepbx-calllive
CALLLIVE_AMI_PORT=5038
CALLLIVE_AMI_SECRET=LOCAL_SECRET
```

### Check the service

```bash
systemctl status freepbx-calllive.service --no-pager -l
journalctl -u freepbx-calllive.service -n 50 --no-pager
systemctl cat freepbx-calllive.service
```

Use the Python executable in the service's `ExecStart` to print the collector version.

```bash
/usr/bin/python3.6 /opt/freepbx-calllive/collector.py --version
```

For a read-only check of the release files and local AMI connection, run the setup command with `--check-only`.

## User access

In **Admin → User Management → Users → Administration GUI**, set **Allow Administration Login → Yes**, set **Grant Full Administration Rights → No**, and include **Call Monitor** in **Administration Access**. The **Administrators** module can also grant this individual section. The user must sign in again after permission changes.

The `calllive` permission grants a view of the whole PBX, including saved calls. The FreePBX extension range does not narrow this section. Full administrators can set shared thresholds and see the setup command. The setup and signing commands run from the PBX root shell.

## History and storage

The default archive retains **30 calendar days**, including today in PBX time, and up to **512 MiB** of completed call records. Records contain metadata and available RTP/RTCP measurements.

| Path | Purpose |
| --- | --- |
| `/run/freepbx-calllive/snapshot.json` | Live snapshot, considered stale after 18 seconds |
| `/var/lib/freepbx-calllive/daily.json` | Daily records |
| `/var/lib/freepbx-calllive/active.json` and `live/` | Active call checkpoints |
| `/var/lib/freepbx-calllive/archive/YYYY-MM-DD/` | Completed JSON records and a daily JSONL catalog |
| `/var/lib/freepbx-calllive/statistics.json` | Daily and hourly observations |

Records are updated roughly every five seconds. After restart, the collector reloads active checkpoints and marks gaps. A call that disappears during an AMI interruption can end with an interrupted or unobserved status. The timeline displays the events Asterisk actually supplied.

Cleanup runs every five minutes. It removes expired days first, then the oldest previous days when the archive exceeds its size limit. If today's archive fills the limit, new completed records can be skipped until space is available. Diagnostics shows skipped records and write errors.

Set retention in the environment file and restart the collector to apply it.

```ini
CALLLIVE_RETENTION_DAYS=30
CALLLIVE_HISTORY_MB=512
```

Allowed values are 1–365 days and 32–8192 MiB. History searches and statistics accept up to 31 days. History returns up to 50 rows per page. Use **Load more** to continue a long search. Search dates follow PBX time. Event times follow the browser time zone.

A call can store up to 64 channels, 500 events and 720 chart points, with fewer points for calls with many channels. When a chart is condensed, CallLive keeps the worse point of adjacent pairs at its recorded timestamp. The latest and worst scores are stored separately. Independent consultation calls can have their own records.

## Quality score

The 0–100 score summarizes RTP/RTCP transport measurements.

```text
Channel score = round(100 × loss factor × jitter factor × RTT factor)
Call score = lowest score among measured channels
```

| Input | Factor 1 | Factor 0 |
| --- | --- | --- |
| Loss | ≤ 0.1% | ≥ 10% |
| Receive jitter at the PBX | ≤ 20 ms | ≥ 100 ms |
| RTT | ≤ 150 ms | ≥ 800 ms |

The factors decrease linearly between their bounds. Receive loss uses received plus lost packets as the denominator. Transmit loss uses transmitted packets. The calculation uses the worse available loss ratio, requires at least 20 packets for that ratio and requires jitter or RTT. Partial coverage and missing data are indicated. Loss counters cover the reporting windows exposed by the Asterisk driver.

The details panel shows the factors, latest and worst scores, coverage and sample time. Select a channel to see its own four charts. Selecting a timeline event adds a time marker and selects the event channel when it has measurements.

## Alerts and statistics

On **Live**, filter calls by low quality, loss, long wait or any alert. Default thresholds are quality below **65%**, loss above **2%**, wait over **30 seconds** and persistence of **10 seconds**. The open dashboard measures persistence from when it first observes a problem. Administrators with full access can change the shared thresholds under **Diagnostics → Alert thresholds**.

Statistics include completed and answered calls, the longest observed conversation, and daily, hourly and trunk peaks. The counts group calls by their PBX start day. Hours outside the observed period are marked separately. Talk time counts observed media connection periods.

## Local signature

Use the signing file for the installed version. It verifies the set and SHA-256 checksums of the module files before signing. The script reuses the local CallLive key where present, installs the signature and verifies it through FreePBX.

If you copied the standalone PHP file to the server, run it as root.

```bash
php /root/calllive-15.0.10-sign-local.php
```

The private key is stored under `/etc/freepbx.secure/calllive-key` with root-only access. FreePBX imports the public key into its own keyring. This is a system-specific signature. If local files differ from the published archive, reinstall the exact archive before signing.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No data from the collector | Service status, snapshot path and permissions, and snapshot age |
| AMI unavailable or login failed | Local port, account secret and ACL. Run setup with `--check-only`. |
| AMI rejected the request | The `reporting` permission and CoreShowChannels, BridgeList and ExtensionStateList actions |
| History cannot be saved | Free space, permissions on `/var/lib/freepbx-calllive`, and archive capacity |
| Transfer or queue events are missing | `read=call,agent` and the AMI event filter |
| Collector update or service check required | Module 15.0.10 expects collector 15.0.8 |
| Signature warning | Use the signing file for the exact installed archive and check the verification message |

A custom deployment should use the correct web-process group and service account. Existing drop-ins can be inspected with `systemctl cat freepbx-calllive.service` and managed with `systemctl edit freepbx-calllive.service`.

## Uninstall

Disable and stop `freepbx-calllive.service`, then uninstall **Call Monitor** in Module Admin. If you remove the dedicated AMI account, environment or service files, reload systemd and AMI after the change. The administrator manages retained history, backups and signing keys separately.

## Platform documentation

- [Install custom FreePBX modules](https://sangomakb.atlassian.net/wiki/spaces/PG/pages/26477115/Download+and+Installing+Custom+Modules)
- [Sign a FreePBX module with a local key](https://sangomakb.atlassian.net/wiki/spaces/FP/pages/10420868/Signing+your+own+modules)
- [Asterisk CHANNEL and RTP/RTCP](https://docs.asterisk.org/Latest_API/API_Documentation/Dialplan_Functions/CHANNEL/)
- [Asterisk Hangup event](https://docs.asterisk.org/Latest_API/API_Documentation/AMI_Events/Hangup/)

[GPLv3 or later](LICENSE).
