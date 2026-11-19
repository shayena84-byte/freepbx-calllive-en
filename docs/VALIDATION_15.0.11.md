# CallLive 15.0.11 validation

Source and package validation was performed on 19 November 2026. This release changes only browser-side polling. The snapshot format, journal, AMI integration and collector 15.0.8 are unchanged.

| Check | Result |
| --- | --- |
| JavaScript | `node --check` passed for `calllive.js`. Exactly one `visibilitychange` handler is registered. |
| Scheduler | Visible intervals are 1 s for the snapshot, 5 s for call details and 10 s for entity details. Hidden intervals are 15, 15 and 30 s. Returning schedules an immediate refresh without a parallel snapshot request. |
| Collector regression | All 20 automated tests passed. AMI, journal, statistics and quality logic are unchanged. |
| Package | The archive has one top-level `calllive` directory, `module.xml` version 15.0.11 and the fixed expected file set. Checksums are published with the package. |
| Compatibility | Module 15.0.11 uses the existing collector 15.0.8. This release does not require a collector update or restart. |

The preceding English package was derived from the FreePBX 15 / Asterisk 16 tested CallLive codebase. After installation on a production PBX, place the normal test call and verify immediate synchronization after returning to the tab.
