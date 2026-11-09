"""Bounded, local call journal. Python 3.6 stdlib; never stores SIP secrets/audio.

The collector is the only writer. PHP reads atomic JSON details/statistics and
locked JSONL daily catalogs, without SQLite/Python/PDO extensions on the web tier.
Durations/peaks are observations, never reconstructed from CDR or an AMI gap.
"""
import hashlib
import json
import math
import os
import re
import shutil
import time
from datetime import datetime, timedelta
from pathlib import Path

VERSION = "15.0.8"
MAX_ACTIVE = 1000
MAX_EVENTS = 500
MAX_POINTS = 720
MAX_CHANNELS = 64
DETAIL_BYTES = 2 * 1024 * 1024
END_GRACE = 3
ID_RE = re.compile(r"^[0-9]{8}-[0-9a-f]{24}$")
ENDPOINT_RE = re.compile(r"^([^/]+)/(.+)-[0-9a-f]+$", re.I)
CONNECTED = {"connected", "held", "conference"}
SERVICE = {"local", "announcer", "recorder", "cbann", "cbrec", "snoop"}


def clean(value, limit=190):
    return str(value or "").replace("\x00", "")[:limit]


def endpoint(name):
    match = ENDPOINT_RE.match(name)
    return match[1].upper() + "/" + match[2] if match else name.split(";", 1)[0]


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def quality(rtp):
    """Same transparent heuristic as the panel, NOT a MOS or speech analysis.

    Asterisk counters have driver-dependent report windows. Loss uses reported
    totals, not counter deltas (lp can be interval loss on Asterisk 16).
    """
    if not rtp:
        return None
    def loss(lost, total):
        if not number(lost) or not number(total) or total < 20 or lost < 0 or lost > total:
            return None
        return lost * 100 / total
    rx, tx = rtp.get("rx_packets"), rtp.get("tx_packets")
    lost = rtp.get("rx_lost")
    inbound = loss(lost, rx + lost) if number(rx) and number(lost) else None
    outbound = loss(rtp.get("tx_lost"), tx)
    losses = [v for v in (inbound, outbound) if v is not None]
    jitter = rtp.get("rx_jitter_ms")
    rtt = rtp.get("rtt_ms")
    jitter = jitter if number(jitter) and jitter >= 0 else None
    rtt = rtt if number(rtt) and rtt >= 0 else None
    if not losses or (jitter is None and rtt is None):
        return None
    def factor(value, good, poor):
        return 1 if value is None else 1 - min(1, max(0, (value - good) / (poor - good)))
    loss_value = max(losses)
    factors = {"loss": factor(loss_value, .1, 10), "jitter": factor(jitter, 20, 100),
               "rtt": factor(rtt, 150, 800)}
    return {"score": int(math.floor(100 * factors["loss"] * factors["jitter"] * factors["rtt"] + .5)),
            "partial": len(losses) < 2 or jitter is None or rtt is None,
            "loss": round(loss_value, 4), "loss_rx": inbound, "loss_tx": outbound,
            "jitter": jitter, "rtt": rtt, "factors": factors, "sampled_at": rtp.get("sampled_at")}


class Journal:
    def __init__(self, root, writer, retention=30, max_mb=512):
        self.root = Path(root)
        self.writer = writer
        self.retention = max(1, min(365, retention))
        self.max_bytes = max(32, min(8192, max_mb)) * 1024 * 1024
        self.archive = self.root / "archive"
        self.active = {}
        self.aliases = {}
        self.stats = {}
        self.last_observe = None
        self.last_stats = 0
        self.next_flush = 0
        self.next_cleanup = 0
        self.storage_error = False
        self.capacity_drops = 0
        self.recovered = False
        self.initial = True
        self.last_catalog = ""
        self.used_bytes = 0
        try:
            self.root.mkdir(parents=True, exist_ok=True, mode=0o750)
            self.archive.mkdir(exist_ok=True, mode=0o750)
            saved = self.load(self.root / "active.json")
            if saved.get("schema") == 1:
                for identifier in saved.get("ids", [])[:MAX_ACTIVE]:
                    if not isinstance(identifier, str) or not ID_RE.match(identifier):
                        continue
                    record = self.load(self.root / "live" / (identifier + ".json"))
                    if isinstance(record.get("channels"), list):
                        record["channels"] = {c["id"]: c for c in record["channels"] if isinstance(c, dict) and c.get("id")}
                    if isinstance(record, dict) and ID_RE.match(record.get("id", "")):
                        self.active[record["id"]] = record
                        self.aliases.update({a: record["id"] for a in record.get("aliases", [])})
                self.recovered = bool(self.active)
                for record in self.active.values():
                    since = record.pop('talking_since', None)
                    if since is not None:
                        record['talk_seconds'] += max(0, record['last_seen'] - since)
            statistics = self.load(self.root / "statistics.json")
            self.stats = statistics.get("days", {})
            self.capacity_drops = max(0, int(statistics.get("capacity_drops", 0)))
            if not isinstance(self.stats, dict):
                self.stats = {}
            self.cleanup(time.time())
        except (OSError, ValueError, TypeError, KeyError) as error:
            self.fail(error)

    def write(self, path, data):
        if len(json.dumps(data, ensure_ascii=False).encode('utf-8')) > 4 * 1024 * 1024:
            raise ValueError('journal file exceeds size limit')
        self.writer(path, data)

    def load(self, path):
        if not path.exists():
            return {}
        with path.open(encoding="utf-8") as file:
            text = file.read(4 * 1024 * 1024 + 1)
        if len(text.encode("utf-8")) > 4 * 1024 * 1024:
            raise ValueError("journal file too large")
        data = json.loads(text)
        return data if isinstance(data, dict) else {}

    def fail(self, error):
        import logging
        if not self.storage_error:
            logging.warning("Call journal unavailable: %s", error)
        self.storage_error = True

    def new(self, alias, now, inferred=0):
        if len(self.active) >= MAX_ACTIVE:
            self.capacity_drops += 1
            return None
        start = max(0, now - max(0, inferred or 0))
        digest = hashlib.sha256((alias + ":" + str(start)).encode("utf-8")).hexdigest()[:24]
        identifier = datetime.fromtimestamp(now).strftime("%Y%m%d") + "-" + digest
        record = {"schema": 1, "id": identifier, "aliases": [alias], "started_at": int(start),
                  "observed_at": int(now), "last_seen": int(now), "ended_at": None,
                  "answered_at": None, "talk_seconds": 0, "status": "active", "channels": {},
                  "timeline": [], "samples": [], "worst_quality": None, "last_quality": None,
                  "sample_interval": 5, "limited": False, "gap": bool(inferred), "causes": []}
        self.active[identifier] = record
        self.aliases[alias] = identifier
        self.event(record, "observed" if inferred else "start", now)
        return record

    def record(self, alias, now, inferred=0):
        identifier = self.aliases.get(alias)
        return self.active.get(identifier) or self.new(alias, now, inferred)

    def event(self, record, kind, now, **fields):
        entry = dict(at=int(now), kind=kind, **{k: clean(v) for k, v in fields.items() if v != "" and v is not None})
        events = record["timeline"]
        if events and events[-1] == entry:
            return
        if len(events) >= MAX_EVENTS:
            # Keep both the initial context and the most recent transfer/hangup.
            del events[100]
            record["limited"] = True
        events.append(entry)

    def consume(self, message, now=None):
        if message.get("actionid"):
            return
        now = time.time() if now is None else now
        kind = message.get("event", "").lower()
        accepted = {"newchannel", "dialbegin", "dialend", "hangup", "hold", "unhold", "bridgeenter",
                    "blindtransfer", "attendedtransfer", "queuecallerjoin", "queuecallerleave", "agentconnect", "agentcomplete"}
        if kind not in accepted:
            return
        alias = message.get("linkedid") or message.get("uniqueid")
        # Transfer events use per-party names rather than the usual Uniqueid.
        if not alias:
            for key in ("transfereruniqueid", "origtransfereruniqueid", "transfereeuniqueid"):
                uid = message.get(key)
                alias = next((a for a, identifier in self.aliases.items()
                              if uid and uid in self.active.get(identifier, {}).get("channels", {})), None)
                if alias:
                    break
        if not alias:
            return
        record = self.record(alias, now)
        if record is None:
            return
        uid = message.get("uniqueid")
        if uid:
            channel = record["channels"].get(uid)
            if channel is None and len(record["channels"]) < MAX_CHANNELS:
                channel = {"id": uid, "name": clean(message.get("channel")), "linked": clean(alias)}
                record["channels"][uid] = channel
            if channel is not None:
                for key, source in (("caller", "calleridnum"), ("caller_name", "calleridname"),
                                    ("connected", "connectedlinenum"), ("context", "context"), ("exten", "exten")):
                    if source in message:
                        channel[key] = clean(message[source])
                if kind == "hangup":
                    channel["ended_at"] = int(now)
                    cause = {"channel": clean(message.get("channel")), "code": clean(message.get("cause"), 8),
                             "text": clean(message.get("cause-txt")), "at": int(now)}
                    if cause not in record["causes"] and len(record["causes"]) < MAX_CHANNELS:
                        record["causes"].append(cause)
        if kind == "newchannel":
            self.event(record, "channel", now, channel=message.get("channel"), caller=message.get("calleridnum"))
        elif kind == "bridgeenter":
            # A bridge may be IVR/holding; answer is confirmed by grouped media in observe().
            return
        else:
            self.event(record, kind, now, channel=message.get("channel"),
                       target=message.get("extension") or message.get("destexten") or message.get("exten") or message.get("destchannel") or message.get("destuniqueid"),
                       queue=message.get("queue"), result=message.get("dialstatus") or message.get("result"),
                       cause=message.get("cause"), reason=message.get("cause-txt"))
        record["last_seen"] = int(now)

    def discontinuity(self, now=None):
        now = time.time() if now is None else now
        for record in self.active.values():
            since = record.pop('talking_since', None)
            if since is not None:
                record['talk_seconds'] += max(0, record['last_seen'] - since)
            if not record.get("gap_open"):
                self.event(record, "gap", now)
                record["gap"] = record["gap_open"] = True
        self.initial = True
        self.last_observe = None
        self.flush(now, force=True)

    def observe(self, data, now=None):
        now = time.time() if now is None else now
        channels = {c["id"]: c for c in data.get("channels", [])}
        live = {}
        active_aliases = {c.get("linked") or c["id"] for c in channels.values()}
        for channel in channels.values():
            if channel["name"].split("/", 1)[0].lower() in SERVICE:
                continue
            alias = channel.get("linked") or channel["id"]
            record = self.record(alias, now, channel.get("age") if self.initial else 0)
            if record is None:
                continue
            identifier = record["id"]
            live[identifier] = record
            record.pop("missing_since", None)
            record["last_seen"] = int(now)
            if record.pop("gap_open", False) or (self.initial and self.recovered):
                record["gap"] = True
                self.event(record, "resumed", now)
            saved = record["channels"].get(channel["id"], {})
            # Only already-sanitized channel metadata, no arbitrary AMI fields.
            if saved or len(record["channels"]) < MAX_CHANNELS:
                saved.update(channel)
                record["channels"][channel["id"]] = saved
            else:
                record["limited"] = True

        talking = set()
        for group in data.get("groups", []):
            records = {self.aliases.get(channels[uid].get("linked") or uid) for uid in group["channels"] if uid in channels}
            records.discard(None)
            if not records:
                continue
            # Retain separate linked calls in attended-transfer/conference topologies;
            # do not merge unrelated participants just because they share a bridge.
            group["call_id"] = sorted(records)[0]
            if group["phase"] in CONNECTED:
                talking.update(records)
            for identifier in records:
                record = self.active.get(identifier)
                if record is None:
                    continue
                if record.get("phase") != group["phase"]:
                    self.event(record, group["phase"], now)
                    record["phase"] = group["phase"]
                if group["phase"] in CONNECTED and record["answered_at"] is None:
                    record["answered_at"] = int(now)

        elapsed = 0 if self.last_observe is None else max(0, min(10, now - self.last_observe))
        self.talking(talking, now)
        for identifier, record in list(self.active.items()):
            record["was_talking"] = identifier in talking
            alias_live = bool(set(record["aliases"]) & active_aliases)
            if identifier not in live and not alias_live:
                if self.initial:
                    record["gap"] = True
                    self.finish(record, record["last_seen"], "interrupted")
                else:
                    record.setdefault("missing_since", now)
                    if now - record["missing_since"] >= END_GRACE:
                        has_cause = bool(record["causes"])
                        self.finish(record, record["last_seen"], "completed" if has_cause else "unobserved_end")
            else:
                self.sample(record, now)
        self.update_statistics(data, now, elapsed)
        self.initial = self.recovered = False
        self.last_observe = now
        self.flush(now)
        self.cleanup(now)

    def sample(self, record, now):
        points = record["samples"]
        measured = []
        for channel in record["channels"].values():
            rtp = channel.get("rtp")
            if not rtp or rtp.get("sampled_at", 0) < now - 15 or channel.get("ended_at"):
                continue
            q = quality(rtp)
            if q:
                measured.append(dict(q, id=channel["id"]))
        if not measured:
            return
        sample_at = max(q["sampled_at"] or 0 for q in measured)
        if sample_at <= record.get("last_sample_at", 0):
            return
        record["last_sample_at"] = sample_at
        worst = min(measured, key=lambda q: q["score"])
        live_count = sum(not c.get("ended_at") and c["name"].split("/", 1)[0].lower() not in SERVICE
                         for c in record["channels"].values())
        sample = {"at": sample_at, "score": worst["score"], "partial": len(measured) < live_count or any(q["partial"] for q in measured),
                  "channels": measured, "coverage": [len(measured), live_count]}
        record["last_quality"] = {k: sample[k] for k in ("at", "score", "partial", "coverage")}
        if record["worst_quality"] is None or sample["score"] < record["worst_quality"]["score"]:
            record["worst_quality"] = dict(record["last_quality"])
        if points and sample_at - points[-1]["at"] < record["sample_interval"]:
            if sample["score"] <= points[-1]["score"]:
                points[-1] = sample
            return
        points.append(sample)
        if len(points) > min(MAX_POINTS, max(20, 4000 // max(1, len(record["channels"])))):
            # Keep worst point in each pair, preserving trouble spikes and actual timestamps.
            record["samples"] = [points[0]] + [min(points[i:min(i+2, len(points)-1)], key=lambda p: p["score"])
                                                      for i in range(1, len(points)-1, 2)] + [points[-1]]
            record["sample_interval"] *= 2
            record["limited"] = True

    def summary(self, record):
        channels = list(record["channels"].values())
        participants = list(dict.fromkeys(clean(
            (c.get("dialed") or c.get("connected") or c.get("caller")) if c.get("direction") == "out"
            else (c.get("caller") or c.get("caller_name") or c["name"]), 80) for c in channels))[:12]
        endpoints = list(dict.fromkeys(endpoint(c["name"]) for c in channels))[:MAX_CHANNELS]
        numbers = list(dict.fromkeys(clean(c.get(key), 80) for c in channels
                                   for key in ("caller", "connected", "dialed", "exten") if c.get(key)))[:64]
        return {"id": record["id"], "started_at": record["started_at"], "ended_at": record["ended_at"],
                "duration": max(0, (record["ended_at"] or record["last_seen"]) - record["started_at"]),
                "talk_seconds": int(record["talk_seconds"]), "answered": record["answered_at"] is not None,
                "participants": participants, "endpoints": endpoints, "numbers": numbers,
                "status": record["status"], "gap": record["gap"],
                "last_quality": record["last_quality"], "worst_quality": record["worst_quality"],
                "causes": record["causes"][:4]}

    def detail_path(self, identifier):
        day = identifier[:8]
        return self.archive / (day[:4] + "-" + day[4:6] + "-" + day[6:8]) / (identifier + ".json")

    def count_record(self, record):
        day = datetime.fromtimestamp(record["started_at"]).date().isoformat()
        if record["id"] not in self.stats.get(day, {}).get("recent_ids", []):
            stats = self.stats.setdefault(day, {"hours": {}, "peak": 0, "longest": 0, "endpoints": {}, "observed_seconds": 0})
            hour = datetime.fromtimestamp(record["started_at"]).strftime("%H")
            slot = stats["hours"].setdefault(hour, {"peak": 0, "observed_seconds": 0})
            for target in (stats, slot):
                target["calls"] = target.get("calls", 0) + 1
                if record["answered_at"] is not None:
                    target["answered"] = target.get("answered", 0) + 1
            stats["longest_call"] = max(stats.get("longest_call", 0), int(record["talk_seconds"]))
            stats["recent_ids"] = (stats.get("recent_ids", []) + [record["id"]])[-128:]

    def finish(self, record, ended, status):
        record["ended_at"] = int(ended)
        record["status"] = status
        self.event(record, "end", ended, result=status)
        self.count_record(record)
        try:
            import fcntl
            path = self.detail_path(record["id"])
            path.parent.mkdir(exist_ok=True, mode=0o750)
            existed = path.exists()
            payload = dict(record, channels=list(record["channels"].values()))
            if len(json.dumps(payload, ensure_ascii=False).encode("utf-8")) > DETAIL_BYTES:
                payload["samples"] = payload["samples"][-120:]
                payload["limited"] = True
            size = len(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
            if not existed and getattr(self, "used_bytes", 0) + size > self.max_bytes:
                self.next_cleanup = 0
                self.cleanup(time.time())
                if getattr(self, "used_bytes", 0) + size > self.max_bytes:
                    self.capacity_drops += 1
                    self.capacity_exceeded = True
                    self.active.pop(record["id"], None)
                    self.aliases = {k: v for k, v in self.aliases.items() if v != record["id"]}
                    self.flush(time.time(), force=True)
                    return
            self.write(path, payload)
            line = json.dumps(self.summary(record), ensure_ascii=False, separators=(",", ":")) + "\n"
            if len(line.encode("utf-8")) > 16384:
                raise ValueError("summary exceeds size limit")
            catalog = path.parent / "catalog.jsonl"
            # A restart after append-before-checkpoint can append an id twice;
            # readers de-duplicate ids and detail writes are idempotent.
            with catalog.open("a", encoding="utf-8") as file:
                fcntl.flock(file, fcntl.LOCK_EX)
                file.write(line)
                file.flush()
                os.fchmod(file.fileno(), 0o640)
            self.last_catalog = record["id"]
            self.used_bytes = getattr(self, "used_bytes", 0) + (0 if existed else size + len(line.encode("utf-8")))
            self.active.pop(record["id"], None)
            self.aliases = {k: v for k, v in self.aliases.items() if v != record["id"]}
            self.flush(time.time(), force=True)
        except (OSError, ValueError) as error:
            self.fail(error)

    def update_statistics(self, data, now, elapsed):
        local = datetime.fromtimestamp(now)
        day = local.date().isoformat()
        hour = local.strftime("%H")
        stats = self.stats.setdefault(day, {"hours": {}, "peak": 0, "longest": 0, "endpoints": {}, "observed_seconds": 0})
        slot = stats["hours"].setdefault(hour, {"peak": 0, "observed_seconds": 0})
        connected = [g for g in data.get("groups", []) if g["phase"] in CONNECTED]
        stats["peak"] = max(stats["peak"], len(connected))
        slot["peak"] = max(slot["peak"], len(connected))
        daily = data.get("daily") or {}
        if daily.get("date") == day:
            stats["peak"] = max(stats["peak"], daily.get("peak", 0))
            stats["longest"] = max(stats["longest"], daily.get("longest", 0))
        # Never assign an unobserved gap or a previous day's seconds to this hour.
        same_slot = self.last_observe is not None and datetime.fromtimestamp(self.last_observe).strftime("%Y-%m-%d %H") == local.strftime("%Y-%m-%d %H")
        seconds = elapsed if same_slot else 0
        stats["observed_seconds"] += seconds
        slot["observed_seconds"] += seconds
        counts = {}
        connected_uids = {uid for group in connected for uid in group["channels"]}
        for channel in data.get("channels", []):
            if channel["id"] in connected_uids:
                key = endpoint(channel["name"])
                counts[key] = counts.get(key, 0) + 1
        for key, count in counts.items():
            stats["endpoints"][key] = max(stats["endpoints"].get(key, 0), count)
        self.last_stats = int(now)

    def peaks(self, groups, channels, now, daily):
        self.update_statistics({"groups": groups, "channels": list(channels.values()), "daily": daily}, now, 0)
        uids = {uid for group in groups for uid in group["channels"]}
        self.talking({identifier for identifier, record in self.active.items() if uids & set(record["channels"])}, now)

    def talking(self, identifiers, now):
        for identifier, record in self.active.items():
            since = record.get("talking_since")
            if identifier in identifiers and since is None:
                record["talking_since"] = now
                if record["answered_at"] is None:
                    record["answered_at"] = int(now)
                    self.event(record, "connected", now)
            elif identifier not in identifiers and since is not None:
                record["talk_seconds"] += max(0, now - since)
                record.pop("talking_since", None)

    def flush(self, now, force=False):
        if not force and now < self.next_flush:
            return
        self.next_flush = now + 5
        try:
            self.write(self.root / "statistics.json", {"schema": 1, "updated_at": self.last_stats, "days": self.stats, "capacity_drops": self.capacity_drops})
            for record in self.active.values():
                path = self.root / "live" / (record["id"] + ".json")
                path.parent.mkdir(exist_ok=True, mode=0o750)
                payload = dict(record, channels=list(record["channels"].values()))
                since = payload.pop('talking_since', None)
                if since is not None:
                    payload['talk_seconds'] += max(0, record['last_seen'] - since)
                self.write(path, payload)
            self.write(self.root / "active.json", {"schema": 1, "ids": list(self.active)})
            self.storage_error = False
        except (OSError, ValueError) as error:
            self.fail(error)

    def cleanup(self, now):
        if now < self.next_cleanup:
            return
        self.next_cleanup = now + 300
        cutoff = (datetime.fromtimestamp(now).date() - timedelta(days=self.retention - 1)).isoformat()
        today = datetime.fromtimestamp(now).date().isoformat()
        try:
            dirs = sorted(p for p in self.archive.iterdir() if p.is_dir() and re.fullmatch(r"\d{4}-\d{2}-\d{2}", p.name))
            total = sum(p.stat().st_size for d in dirs for p in d.iterdir() if p.is_file())
            for directory in dirs:
                size = sum(p.stat().st_size for p in directory.iterdir() if p.is_file())
                if directory.name < cutoff or (total > self.max_bytes and directory.name != today):
                    shutil.rmtree(str(directory))
                    total -= size
            self.capacity_exceeded = total > self.max_bytes
            self.used_bytes = total
            self.stats = {d: value for d, value in self.stats.items() if d >= cutoff}
            while len(json.dumps(self.stats, ensure_ascii=False).encode('utf-8')) > 3 * 1024 * 1024:
                del self.stats[min(self.stats)]
            live = self.root / "live"
            if live.exists():
                for path in live.glob("*.json"):
                    if path.stem not in self.active:
                        path.unlink()
        except OSError as error:
            self.fail(error)

    def view(self):
        return {"enabled": True, "retention_days": self.retention, "max_mb": self.max_bytes // (1024 * 1024),
                "storage_error": self.storage_error, "capacity_exceeded": getattr(self, "capacity_exceeded", False),
                "capacity_drops": self.capacity_drops, "active_records": len(self.active),
                "last_completed_id": self.last_catalog}
