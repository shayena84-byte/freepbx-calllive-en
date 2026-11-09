# CallLive 15.0.10 validation

The upgrade ran through the native Module Admin route on an isolated FreePBX 15.0.38 system with Core 15.0.22.39, Asterisk 16.2.1 and PHP 7.4.

| Check | Result |
| --- | --- |
| Module upgrade | Installed the published English archive over locally signed CallLive 15.0.9. FreePBX reported module version 15.0.10. |
| Local signing | Signed 15.0.10 with the existing test key. FreePBX accepted the signature and reloaded its configuration. |
| Collector compatibility | The running 15.0.8 collector kept the same process during the module upgrade. Its saved call record was byte-identical after the upgrade. |
| Collector setup | Preflight and setup reached native Asterisk AMI. The test covered setup with an older collector and preserved history after the update. |
| GUI and access | The English report route, JavaScript and stylesheet returned HTTP 200. Full admins and users assigned the section passed the view check. Unassigned users, expired sessions and guests were denied. |
| Browser logic | DOM tests covered live and archived call details, event markers, four quality charts, details after hangup, statistics, diagnostics, alert filtering and access expiry. |
| Package and code | Release checksums, PHP, JavaScript and shell syntax checks, and 17 Python tests passed. |

A live PJSIP call on the lab system produced ringing and answer events, a codec, RTP/RTCP samples and an archived call card. The upgrade reused that archive record to check history preservation. Service management used a systemd test fixture, and the Python 3.6 path selection was tested using the lab interpreter. The README screens use demonstration data.
