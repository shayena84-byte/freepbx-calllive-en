# CallLive architecture

## Data flow

The Python collector runs as a dedicated systemd service on the PBX and connects to local Asterisk AMI. CoreShowChannels, BridgeList and ExtensionStateList provide reconciled state. Events update state between full queries. Status and Getvar supply SIP/PJSIP formats and available RTCP measurements. The service atomically publishes its JSON snapshot with mode `0640`.

The PHP module checks the FreePBX session, the `calllive` permission and whether the module is enabled. It treats snapshots older than 18 seconds as stale. It reads extension and trunk data from FreePBX and uses bounded AMI queries for supplementary details.

The browser polls for live state about once per second. Active technical records refresh about every five seconds. History and statistics load on demand. Charts use local SVG. When the user selects a timeline event, the browser marks its timestamp and selects the matching channel if measurements exist.

## Source files

| File | Responsibility |
| --- | --- |
| `calllive/Calllive.class.php` | Session and permission checks, bounded read API, and CSRF-protected thresholds |
| `calllive/page.calllive.php` | Dashboard markup, navigation and dialogs |
| `calllive/assets/js/calllive.js` | Polling, channel matching, technical details, SVG, filters and diagnostics |
| `calllive/assets/css/calllive.css` | Responsive dashboard and call details |
| `calllive/deploy/collector.py` | AMI state, bridges, RTP, daily peaks and reconnects |
| `calllive/deploy/telemetry.py` | Call journal, events, quality samples, statistics, retention and recovery |
| `calllive/deploy/update-root.sh` | Collector preflight, setup, backup and restoration |
| `calllive/deploy/freepbx-calllive.service` | Unprivileged service, environment and runtime restrictions |
| `calllive/deploy/files.sha256` | Installed module file integrity checks for setup |
| `tests/` | Collector and journal unit tests |

## Journal

Persistent data lives under `/var/lib/freepbx-calllive`. The `active.json` checkpoint lists active call IDs with detailed records under `live/`. Completed records are written to `archive/YYYY-MM-DD/` and appended to a daily `catalog.jsonl` index. The single collector writes detailed JSON and statistics through atomic replacements. PHP reads catalogs under a shared lock and deduplicates repeated IDs.

A record ID contains an observation date and 24 hexadecimal characters derived from the Linkedid and time. Requests accept validated IDs and catalog cursors. The collector stores an allowlisted set of channel and AMI fields.

History groups by Linkedid, while live rows group media bridges. This preserves transfer sequences without collapsing independent consultation calls into one history entry. A logical call can have more than one live row.

The collector marks AMI gaps and reloads checkpoints after restart. A call that disappears across a gap may be marked `interrupted`. When Hangup was unavailable, the journal can use `unobserved_end`. Observed talk time includes the periods where media connection was recorded.

The default archive is 30 calendar days and 512 MiB. Archive, channel, event and chart limits bound resource use. On chart reduction, adjacent samples keep the worse quality point at its original time. The latest and worst measurements are preserved separately.

## API and access

Responses carry `Cache-Control: no-store, private`. Permission `calllive` gives read access to the whole PBX.

| Command | Method | Access | Result |
| --- | --- | --- | --- |
| `snapshot` | GET | calllive | Current state, versions, thresholds and daily peaks. `inventory=1` adds the directory. |
| `extension`, `trunk` | GET | calllive | Configuration and status fields for the selected entity |
| `history` | GET | calllive | Date and number or channel search, up to 50 rows, continuation cursor |
| `call` | GET | calllive | Active or saved technical record by validated ID |
| `statistics` | GET | calllive | Daily and hourly observations and endpoint peaks |
| `diagnostics` | GET | calllive | Snapshot, history, service and compatibility status. Root setup command for full admins. |
| `settings` | POST | Full admin and CSRF | Shared alert thresholds in `calllive_settings` |

The history reader limits date ranges, line lengths, rows scanned and time per request. A continuation cursor identifies a validated date and byte position. Root operations are run by the administrator in the server shell.

## Quality and statistics

Python `quality()` and JavaScript `channelQuality()` multiply factors for loss, receive jitter and RTT. The call score uses the lowest measured channel score. The factors range over 0.1–10% loss, 20–100 ms jitter and 150–800 ms RTT. A valid loss measurement and a time measurement are needed. The [module manual](../calllive/README.md#quality-score) explains the scale and missing data.

`LiveConversations` captures short bridges between full snapshots. Daily records are stored in `daily.json`. `Journal` writes historical peaks by day, hour and endpoint. FreePBX directory mappings associate endpoints with trunks. Counts group completed calls by start date. Hours without observation are distinguished from observed zero load. Recent record IDs prevent repeat counts after recovery.

## Setup and signatures

The installer reads the installed module, verifies SHA-256 checksums and backs up a fixed set of collector paths. It preserves AMI credentials and systemd drop-ins. It requires a fresh snapshot from collector **15.0.8**, with ready AMI and writable history. Module **15.0.10** can use an existing healthy collector 15.0.8.

The release signing script verifies the exact installed file list. It creates `/etc/freepbx.secure/calllive.sig` and the module's `module.sig`, imports the public key and verifies the resulting FreePBX signature status. The private key remains on the PBX.
