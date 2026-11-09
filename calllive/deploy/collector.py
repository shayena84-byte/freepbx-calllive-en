#!/usr/bin/env python3
"""Maintain a current, local snapshot of Asterisk AMI call activity."""

import json
import logging
import math
import os
import re
import socket
import tempfile
import time
import sys
from collections import defaultdict, deque
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from telemetry import Journal, VERSION, quality

STARTED = time.monotonic()

SNAPSHOT = Path("/run/freepbx-calllive/snapshot.json")
DAILY = Path("/var/lib/freepbx-calllive/daily.json")
RECONCILE_SECONDS = 5.0
MIN_REFRESH_SECONDS = 0.75
IO_TIMEOUT = 4.0
MEDIA_INTERVAL = 5.0
MEDIA_TIMEOUT = 0.65
MEDIA_MAX_AGE = 15.0
MAX_RTP_QUERIES = 32
MAX_FRAME_BYTES = 1024 * 1024
MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024
EVENTS = {
    "newchannel", "newstate", "newcallerid", "newconnectedline", "hangup",
    "dialbegin", "dialend", "bridgecreate", "bridgedestroy", "bridgeenter",
    "bridgeleave", "bridgemerge", "extensionstatus", "hold", "unhold",
    "parkedcall", "unparkedcall", "parkedcalltimeout", "parkedcallgiveup",
    "blindtransfer", "attendedtransfer", "queuecallerjoin", "queuecallerleave", "agentconnect", "agentcomplete",
}
MEDIA_BRIDGES = {"simple_bridge", "native_rtp", "softmix"}
CONNECTED_PHASES = {"connected", "held", "conference"}
RTP_VARIABLES = {"pjsip": "CHANNEL(rtcp,all)", "sip": "CHANNEL(rtpqos,audio,all)"}
SERVICE_CHANNELS = {"local", "announcer", "recorder", "cbann", "cbrec", "snoop"}
INBOUND_CONTEXT = re.compile(r"^(from-(pstn|trunk|did-direct|external)|ext-did)(-|$)")


class AmiError(Exception):
    def __init__(self, state, message):
        super().__init__(message)
        self.state = state


class Ami:
    def __init__(self, connection, on_event):
        self.connection = connection
        self.on_event = on_event
        self.buffer = b""
        self.sequence = 0
        banner = self.read_until(b"\r\n", time.monotonic() + IO_TIMEOUT)
        if not banner.startswith(b"Asterisk Call Manager/"):
            raise AmiError("ami_offline", "Unexpected AMI banner")

    def read_until(self, delimiter, deadline):
        while True:
            index = self.buffer.find(delimiter)
            if index >= 0:
                if index > MAX_FRAME_BYTES:
                    break
                frame = self.buffer[:index]
                self.buffer = self.buffer[index + len(delimiter):]
                return frame
            if len(self.buffer) > MAX_FRAME_BYTES:
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise socket.timeout("AMI response timed out")
            self.connection.settimeout(remaining)
            chunk = self.connection.recv(65536)
            if not chunk:
                raise ConnectionError("AMI closed the connection")
            self.buffer += chunk
        raise AmiError("ami_offline", "AMI frame exceeds the size limit")

    def receive(self, deadline):
        message = {}
        while not message:
            frame = self.read_until(b"\r\n\r\n", deadline)
            for line in frame.decode("utf-8", errors="replace").split("\r\n"):
                key, separator, value = line.partition(":")
                if separator:
                    message.setdefault(key.strip().lower(), value.strip())
        return message

    def exchange(self, action, item=None, complete=None, *, reply=False, timeout=IO_TIMEOUT, **headers):
        self.sequence += 1
        action_id = "calllive-{}".format(self.sequence)
        headers = dict(Action=action, ActionID=action_id, **headers)
        payload = "".join("{}: {}\r\n".format(k, v) for k, v in headers.items())
        self.connection.settimeout(timeout)
        self.connection.sendall((payload + "\r\n").encode("utf-8"))

        deadline = time.monotonic() + timeout
        items = []
        while time.monotonic() < deadline:
            message = self.receive(deadline)
            if message.get("actionid") != action_id:
                self.on_event(message)
                continue
            response = message.get("response", "").lower()
            event = message.get("event", "").lower()
            if response and response != "success":
                state = "ami_auth" if action == "Login" else "ami_action"
                raise AmiError(state, "{} rejected by AMI".format(action))
            if (response and not complete) or (complete and event == complete):
                return message if reply else items
            if item and event == item:
                items.append(message)
                if len(items) > 50000:
                    raise AmiError("ami_action", "{} exceeds the item limit".format(action))
        raise socket.timeout("{} timed out".format(action))


def dialed_number(dial_string):
    for part in reversed(dial_string.split("/")):
        candidate = re.sub(r"^sips?:", "", part, flags=re.IGNORECASE)
        number = re.split(r"[@;]", candidate, maxsplit=1)[0]
        if re.fullmatch(r"\+?[0-9*#]{2,40}", number):
            return number
    return ""


class LiveEvents:
    def __init__(self):
        self.changed = True
        self.details = {}

    def consume(self, message):
        event = message.get("event", "").lower()
        if event not in EVENTS or message.get("actionid"):
            return
        self.changed = True
        uid = message.get("uniqueid")
        if event == "hangup":
            self.details.pop(uid, None)
            return
        if event == "dialbegin":
            uid = message.get("destuniqueid")
            patch = {"direction": "out", "dialed": dialed_number(message.get("dialstring", ""))}
        elif event in {"hold", "unhold"}:
            patch = {"held": event == "hold"}
        elif event == "newchannel" and INBOUND_CONTEXT.match(message.get("context", "")):
            linked = message.get("linkedid")
            if linked and linked != uid:
                return
            patch = {"direction": "in"}
        else:
            return
        if uid:
            self.details.setdefault(uid, {}).update(patch, seen=time.monotonic())

    def prune(self, active, started):
        # A new leg may arrive after CoreShowChannels has already listed its channels.
        self.details = {
            uid: detail for uid, detail in self.details.items()
            if uid in active or detail["seen"] >= started - RECONCILE_SECONDS
        }


def channel_age(duration):
    parts = duration.split(":")
    if len(parts) != 3 or any(not re.fullmatch(r"[0-9]{1,7}", part) for part in parts):
        return None
    hours, minutes, seconds = (int(part) for part in parts)
    return hours * 3600 + minutes * 60 + seconds


def channel_row(message, detail, bridges):
    uid = message["uniqueid"]
    linked = message.get("linkedid") or uid
    direction = detail.get("direction", "")
    if not direction and linked == uid and INBOUND_CONTEXT.match(message.get("context", "")):
        direction = "in"
    bridge = message.get("bridgeid", "")
    return {
        "id": uid, "linked": linked, "name": message["channel"],
        "state": message.get("channelstatedesc", "").lower(),
        "bridge": bridge, "bridge_type": bridges.get(bridge, {}).get("bridgetechnology", ""),
        "context": message.get("context", ""), "exten": message.get("exten", ""),
        "app": message.get("application", "").lower(),
        "caller": message.get("calleridnum", ""),
        "caller_name": message.get("calleridname", ""),
        "connected": message.get("connectedlinenum", ""),
        "direction": direction, "dialed": detail.get("dialed", ""),
        "held": detail.get("held", False), "age": channel_age(message.get("duration", "")),
    }


def service_channel(channel):
    return channel["name"].partition("/")[0].lower() in SERVICE_CHANNELS


def group_calls(channels, bridges, connected_only=False):
    members = defaultdict(list)
    local_halves = defaultdict(dict)
    for uid, channel in channels.items():
        bridge_id = channel["bridge"]
        if channel["state"] != "up" or bridges.get(bridge_id, {}).get("bridgetechnology") not in MEDIA_BRIDGES:
            continue
        members[bridge_id].append(uid)
        if channel["name"].lower().startswith("local/"):
            local_name, _, side = channel["name"].rpartition(";")
            if side in {"1", "2"}:
                local_halves[local_name][side] = bridge_id

    links = defaultdict(set)
    for halves in local_halves.values():
        if "1" in halves and "2" in halves:
            links[halves["1"]].add(halves["2"])
            links[halves["2"]].add(halves["1"])

    groups = []
    assigned = set()

    def add_group(phase, participants, source, bridge_ids=()):
        ages = [channels[uid]["age"] for uid in source if channels[uid]["age"] is not None]
        group = {"phase": phase, "channels": sorted(participants), "age": max(ages) if ages else None}
        if connected_only and bridge_ids:
            group["bridges"] = sorted(bridge_ids)
        groups.append(group)

    visited = set()
    for first_bridge in members:
        if first_bridge in visited:
            continue
        pending = [first_bridge]
        component = set()
        while pending:
            bridge_id = pending.pop()
            if bridge_id in visited:
                continue
            visited.add(bridge_id)
            component.add(bridge_id)
            pending.extend(links[bridge_id] - visited)
        source = [uid for bridge_id in component for uid in members[bridge_id]]
        participants = [uid for uid in source if not service_channel(channels[uid])]
        if len(participants) < 2:
            continue
        conference = len(participants) > 2 or any(
            bridges[bridge_id].get("bridgecreator", "").lower() == "confbridge"
            for bridge_id in component
        )
        held = any(channels[uid]["held"] for uid in participants)
        phase = "conference" if conference else "held" if held else "connected"
        add_group(phase, participants, source, component)
        assigned.update(source)

    if connected_only:
        return groups

    remaining = defaultdict(list)
    for uid, channel in channels.items():
        if uid not in assigned:
            remaining[channel["linked"]].append(uid)

    for source in remaining.values():
        participants = [uid for uid in source if not service_channel(channels[uid])]
        if not participants:
            continue
        states = {channels[uid]["state"] for uid in participants}
        apps = {channels[uid]["app"] for uid in source}
        holding_bridge = any(
            bridges.get(channels[uid]["bridge"], {}).get("bridgetechnology") == "holding_bridge"
            for uid in source
        )
        if states & {"ring", "ringing", "dialing", "pre-ring", "dialing offhook"}:
            phase = "ringing"
        elif apps & {"park", "parkedcall"}:
            phase = "parked"
        elif "queue" in apps:
            phase = "queue"
        elif holding_bridge or any(channels[uid]["held"] for uid in participants):
            phase = "waiting"
        elif apps & {"voicemail", "voicemailmain", "background", "waitexten", "playback"}:
            phase = "service"
        else:
            phase = "setup"
        add_group(phase, participants, source)
    return sorted(groups, key=lambda group: (-(group["age"] or 0), group["channels"]))


class DailyStats:
    def __init__(self, path):
        self.path = path
        self.day = ""
        self.peak = self.longest = 0
        self.active = {}
        self.next_save = 0.0
        self.storage_error = False
        self.dirty = False
        try:
            with path.open(encoding="utf-8") as file:
                saved = json.loads(file.read(MAX_SNAPSHOT_BYTES + 1))
            if saved["schema"] != 1 or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", saved["date"]):
                raise ValueError("unsupported daily data")
            peak = max(0, int(saved["peak"]))
            longest = max(0, int(saved["longest"]))
            active = {key: value for key, value in saved["active"].items()
                      if isinstance(value, (int, float)) and math.isfinite(value) and value > 0}
            self.day, self.peak, self.longest, self.active = saved["date"], peak, longest, active
        except FileNotFoundError:
            pass
        except (OSError, ValueError, KeyError, TypeError, AttributeError, OverflowError) as error:
            logging.warning("Cannot read daily statistics: %s", error)

    def observe(self, groups, now, continuous=True):
        local = datetime.fromtimestamp(now)
        day = local.date().isoformat()
        midnight = local.replace(hour=0, minute=0, second=0, microsecond=0, fold=0).timestamp()
        rollover = day != self.day
        if rollover:
            self.day = day
            self.peak = self.longest = 0

        keys = {",".join(group["bridges"]) for group in groups if group.get("bridges")}
        active = {key: min(now, self.active.get(key, now)) for key in keys}
        starts = list(active.values())
        if continuous:
            starts.extend(start for key, start in self.active.items() if key not in active)
        longest = max((int(max(0, now - max(start, midnight))) for start in starts), default=0)
        peak = max(self.peak, len(active))
        longest = max(self.longest, longest)
        changed = rollover or active != self.active or peak > self.peak
        self.dirty = self.dirty or changed or longest > self.longest
        self.peak, self.longest, self.active = peak, longest, active

        clock = time.monotonic()
        if self.dirty and (clock >= self.next_save or (changed and not self.storage_error)):
            self.next_save = clock + RECONCILE_SECONDS
            try:
                write_json(self.path, {"schema": 1, "date": day, "peak": peak,
                                       "longest": longest, "active": active})
                self.dirty = self.storage_error = False
            except (OSError, AmiError) as error:
                if not self.storage_error:
                    logging.warning("Cannot save daily statistics: %s", error)
                self.storage_error = True

    def view(self):
        if self.day != datetime.now().date().isoformat():
            return None
        return {"date": self.day, "peak": self.peak, "longest": self.longest,
                "storage_error": self.storage_error}


class LiveConversations:
    """Apply bridge events between full captures, using the same grouping as the panel."""

    EVENTS = {"bridgeenter", "bridgeleave", "bridgedestroy", "newstate", "hangup"}

    def __init__(self, daily, journal=None):
        self.daily = daily
        self.journal = journal
        self.channels = {}
        self.bridges = {}
        self.pending = None
        self.ready = False

    def begin(self):
        self.pending = deque(maxlen=20000)

    def reconcile(self, channels, bridges):
        self.channels = {uid: dict(channel) for uid, channel in channels.items() if channel["bridge"]}
        self.bridges = dict(bridges)
        for message in self.pending:
            self.apply(message)
        self.pending = None
        self.update(continuous=self.ready)
        self.ready = True

    def update(self, continuous=True):
        groups = group_calls(self.channels, self.bridges, connected_only=True)
        self.daily.observe(groups, time.time(), continuous=continuous)
        if self.journal is not None:
            self.journal.peaks(groups, self.channels, time.time(), self.daily.view())

    def consume(self, message):
        if message.get("actionid") or message.get("event", "").lower() not in self.EVENTS:
            return
        if self.pending is not None:
            self.pending.append(message)
        if self.ready and self.apply(message):
            self.update()

    def apply(self, message):
        event = message.get("event", "").lower()
        bridge = message.get("bridgeuniqueid")
        uid = message.get("uniqueid")
        if event == "bridgeenter" and bridge and uid and message.get("channel"):
            self.bridges[bridge] = message
            self.channels[uid] = {
                "id": uid, "name": message["channel"], "bridge": bridge,
                "state": message.get("channelstatedesc", "").lower(), "held": False, "age": None,
            }
            return True
        if event == "bridgedestroy" and bridge:
            return self.bridges.pop(bridge, None) is not None
        if uid not in self.channels:
            return False
        if event == "hangup" or (event == "bridgeleave" and self.channels[uid]["bridge"] == bridge):
            del self.channels[uid]
            return True
        if event == "newstate" and message.get("channelstatedesc"):
            state = message["channelstatedesc"].lower()
            changed = self.channels[uid]["state"] != state
            self.channels[uid]["state"] = state
            return changed
        return False


def capture(ami, events, started, conversations=None):
    if conversations is not None:
        conversations.begin()
    raw_channels = ami.exchange("CoreShowChannels", "coreshowchannel", "coreshowchannelscomplete")
    raw_bridges = ami.exchange("BridgeList", "bridgelistitem", "bridgelistcomplete")
    raw_hints = ami.exchange("ExtensionStateList", "extensionstatus", "extensionstatelistcomplete")
    bridges = {message["bridgeuniqueid"]: message for message in raw_bridges if message.get("bridgeuniqueid")}
    channels = {
        message["uniqueid"]: channel_row(message, events.details.get(message["uniqueid"], {}), bridges)
        for message in raw_channels if message.get("uniqueid") and message.get("channel")
    }
    hints = []
    for message in raw_hints:
        if message.get("context") != "ext-local" or not message.get("exten"):
            continue
        status = message.get("status", "")
        if re.fullmatch(r"-?[0-9]{1,4}", status):
            hints.append({"ext": message["exten"], "status": int(status), "hint": message.get("hint", "")})
    events.prune(channels, started)
    if conversations is not None:
        conversations.reconcile(channels, bridges)
    return {"state": "ready", "channels": list(channels.values()), "groups": group_calls(channels, bridges), "hints": hints}


def rtp_stats(value):
    fields = dict(part.split("=", 1) for part in value.split(";") if "=" in part)

    def counter(key, limit=0xffffffff):
        raw = fields.get(key, "")
        return int(raw) if re.fullmatch(r"[0-9]{1,10}", raw) and int(raw) <= limit else None

    def decimal(key):
        try:
            number = float(fields[key])
        except (KeyError, ValueError):
            return None
        return number if math.isfinite(number) and number >= 0 else None

    rx = counter("rxcount")
    tx = counter("txcount")
    lost_rx = counter("lp", 0x7fffff)
    lost_tx = counter("rlp", 0xffffff)
    rtt = decimal("rtt")
    # Asterisk uses 16.16 time for RTCP and can expose a wrapped RTT after clock skew.
    rtt = rtt if rtt and rtt < 60 else None
    # In the RTP engine txjitter is the local receive jitter, in seconds.
    # Asterisk 16 scales the peer's rxjitter differently. Only use it as evidence of a report.
    jitter = decimal("txjitter")
    peer_report = rtt is not None or bool(decimal("rxjitter")) or bool(lost_tx)
    if not (rx or tx or peer_report):
        return None
    # The peer's cumulative loss is a signed 24-bit value. Negative means duplicates.
    if lost_tx is not None and lost_tx & 0x800000:
        lost_tx = 0
    return {
        "rx_packets": rx, "tx_packets": tx,
        "rx_jitter_ms": round(jitter * 1000, 2) if jitter and jitter < 60 and rx and rx > 1 else None,
        # A zero lp is also the initial value before Asterisk has sent an RTCP report.
        "rx_lost": lost_rx if rx and lost_rx else None,
        "tx_lost": lost_tx if peer_report else None,
        "rtt_ms": round(rtt * 1000, 2) if rtt is not None else None,
    }


class LiveMedia:
    def __init__(self):
        self.codecs = {}
        self.quality = {}
        self.cursor = 0
        self.next_check = None

    def sample(self, ami, channels, now):
        deadline = now + MEDIA_TIMEOUT
        try:
            status = ami.exchange("Status", "status", "statuscomplete", timeout=MEDIA_TIMEOUT)
        except (AmiError, socket.timeout):
            status = []
        for message in status:
            uid = message.get("uniqueid")
            if uid in channels:
                self.codecs[uid] = (now, {
                    "native": message.get("nativeformats", "")[:160].strip("()"),
                    "read": message.get("readformat", "")[:64],
                    "write": message.get("writeformat", "")[:64],
                })

        sip = []
        for channel in channels.values():
            variable = RTP_VARIABLES.get(channel["name"].partition("/")[0].lower())
            if variable:
                sip.append((channel, variable))
        for _ in range(min(MAX_RTP_QUERIES, len(sip))):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            channel, variable = sip[self.cursor % len(sip)]
            self.cursor += 1
            try:
                result = ami.exchange("Getvar", Channel=channel["name"], Variable=variable,
                                      reply=True, timeout=remaining)
            except AmiError:
                # The channel may have hung up after CoreShowChannels.
                continue
            except socket.timeout:
                break
            self.quality[channel["id"]] = (now, int(time.time()), rtp_stats(result.get("value", "")))

    def attach(self, ami, data):
        now = time.monotonic()
        active = {uid for group in data["groups"] if group["phase"] in CONNECTED_PHASES for uid in group["channels"]}
        channels = {channel["id"]: channel for channel in data["channels"] if channel["id"] in active}
        for cache in (self.codecs, self.quality):
            for uid, sample in list(cache.items()):
                if uid not in channels or now - sample[0] > MEDIA_MAX_AGE:
                    del cache[uid]
        if not channels:
            self.next_check = None
            return
        if self.next_check is None or now >= self.next_check:
            self.next_check = now + MEDIA_INTERVAL
            self.sample(ami, channels, now)
        for uid, channel in channels.items():
            if uid in self.codecs:
                channel["codecs"] = self.codecs[uid][1]
            if uid in self.quality:
                _, sampled_at, stats = self.quality[uid]
                if stats is not None:
                    channel["rtp"] = dict(stats, sampled_at=sampled_at)


def write_json(path, data):
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(payload) > MAX_SNAPSHOT_BYTES:
        raise AmiError("snapshot_limit", "Snapshot exceeds the size limit")
    fd, temporary = tempfile.mkstemp(prefix=".snapshot-", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(payload)
            os.fchmod(output.fileno(), 0o640)
        os.replace(temporary, str(path))
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def publish(path, data):
    data.update(schema=1, updated_at=int(time.time()))
    data["collector_version"] = VERSION
    data["diagnostics"] = dict(data.get("diagnostics", {}), python=sys.version.split()[0],
                               uptime_seconds=int(time.monotonic() - STARTED), sample_interval=MEDIA_INTERVAL,
                               media_max_age=MEDIA_MAX_AGE, event_scope="call,agent")
    write_json(path, data)


def run_session(connection, username, secret, path, once=False, daily=None, journal=None):
    events = LiveEvents()
    media = LiveMedia()
    conversations = LiveConversations(daily, journal) if daily is not None else None

    def consume(message):
        events.consume(message)
        if journal is not None:
            journal.consume(message)
        if conversations is not None:
            conversations.consume(message)

    ami = Ami(connection, consume)
    ami.exchange("Login", Username=username, Secret=secret, Events="call,agent")
    next_check = 0.0
    earliest = 0.0
    while True:
        now = time.monotonic()
        if now >= next_check or (events.changed and now >= earliest):
            events.changed = False
            data = capture(ami, events, now, conversations)
            if once:
                return data
            media.attach(ami, data)
            if daily is not None:
                data["daily"] = daily.view()
            if journal is not None:
                journal.observe(data)
                data["journal"] = journal.view()
            for group in data["groups"]:
                measured = [quality(channel.get("rtp")) for channel in data["channels"] if channel["id"] in group["channels"]]
                known = [q for q in measured if q]
                if known:
                    group["quality"] = {"score": min(q["score"] for q in known),
                                        "partial": len(known) < len(measured) or any(q["partial"] for q in known)}
            publish(path, data)
            earliest = now + MIN_REFRESH_SECONDS
            next_check = time.monotonic() + RECONCILE_SECONDS
            if media.next_check is not None:
                next_check = min(next_check, media.next_check)
        else:
            deadline = min(earliest, next_check) if events.changed else next_check
            try:
                consume(ami.receive(deadline))
            except socket.timeout:
                continue


def main():
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Check AMI and print counts only")
    parser.add_argument("--version", action="version", version=VERSION)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    username = os.environ.get("CALLLIVE_AMI_USER", "freepbx-calllive")
    secret = os.environ.get("CALLLIVE_AMI_SECRET", "")
    port = os.environ.get("CALLLIVE_AMI_PORT", "5038")
    if not username or not secret or any(char in username + secret for char in "\r\n\x00"):
        parser.error("Set CALLLIVE_AMI_USER and CALLLIVE_AMI_SECRET in the service environment")
    if not port.isdigit() or not 1 <= int(port) <= 65535:
        parser.error("Invalid CALLLIVE_AMI_PORT")

    daily = None if args.check else DailyStats(DAILY)
    try:
        retention = int(os.environ.get("CALLLIVE_RETENTION_DAYS", "30"))
        max_mb = int(os.environ.get("CALLLIVE_HISTORY_MB", "512"))
    except ValueError:
        parser.error("Invalid journal retention/storage limit")
    journal = None if args.check else Journal(DAILY.parent, write_json, retention, max_mb)
    delay = 1
    while True:
        started = time.monotonic()
        try:
            with socket.create_connection(("127.0.0.1", int(port)), timeout=IO_TIMEOUT) as connection:
                data = run_session(connection, username, secret, SNAPSHOT, once=args.check, daily=daily, journal=journal)
                if args.check:
                    print("CallLive {}. AMI OK. Channels: {}, hints: {}.".format(VERSION, len(data["channels"]), len(data["hints"])))
                    return 0
        except (OSError, AmiError) as error:
            state = error.state if isinstance(error, AmiError) else "ami_offline"
            logging.warning("%s: %s", state, error)
            if args.check:
                return 1
            journal.discontinuity()
            publish(SNAPSHOT, {"state": state, "daily": daily.view(), "journal": journal.view()})
            if time.monotonic() - started > 30:
                delay = 1
            time.sleep(delay)
            delay = min(15, delay * 2)


if __name__ == "__main__":
    raise SystemExit(main())
