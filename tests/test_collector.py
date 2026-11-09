import importlib.util
import json
import socket
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("collector", "calllive/deploy/collector.py")
cl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cl)


def channel(uid, name, bridge="", linked="root", state="up", app="", held=False, age=30):
    return {"id": uid, "linked": linked, "name": name, "bridge": bridge, "state": state,
            "app": app, "held": held, "age": age}


def group(channels, **bridges):
    return cl.group_calls(
        {entry["id"]: entry for entry in channels},
        {key: {"bridgetechnology": value} for key, value in bridges.items()},
    )


class CollectorTests(unittest.TestCase):
    def test_pending_and_connected_are_separate(self):
        data = group([
            channel("1", "PJSIP/201-a", "a"),
            channel("2", "PJSIP/provider-b", "a"),
            channel("3", "SIP/202-c", state="ringing"),
        ], a="native_rtp")
        self.assertEqual([(x["phase"], x["channels"]) for x in data],
                         [("connected", ["1", "2"]), ("ringing", ["3"])])

    def test_holding_bridge_does_not_connect_callers(self):
        data = group([
            channel("1", "PJSIP/201-a", "a"),
            channel("2", "PJSIP/provider-b", "a"),
        ], a="holding_bridge")
        self.assertEqual(data[0]["phase"], "waiting")

    def test_bridged_local_pair_for_queue_agent(self):
        data = group([
            channel("1", "PJSIP/provider-a", "a"),
            channel("2", "Local/201@from-queue-00000001;1", "a"),
            channel("3", "Local/201@from-queue-00000001;2", "b"),
            channel("4", "PJSIP/201-d", "b"),
        ], a="simple_bridge", b="native_rtp")
        self.assertEqual(data, [{"phase": "connected", "channels": ["1", "4"], "age": 30}])

    def test_same_linkedid_with_two_media_bridges(self):
        data = group([
            channel("1", "PJSIP/201-a", "a"),
            channel("2", "PJSIP/202-b", "a"),
            channel("3", "PJSIP/203-c", "b"),
            channel("4", "PJSIP/204-d", "b"),
        ], a="simple_bridge", b="native_rtp")
        self.assertEqual([g["channels"] for g in data], [["1", "2"], ["3", "4"]])

    def test_hold_and_conference(self):
        data = group([
            channel("1", "PJSIP/201-a", "a", held=True),
            channel("2", "PJSIP/202-b", "a"),
            channel("3", "PJSIP/203-c", "b"),
            channel("4", "PJSIP/204-d", "b"),
            channel("5", "PJSIP/205-e", "b"),
            channel("6", "CBAnn/conf-00000000;1", "b"),
        ], a="simple_bridge", b="softmix")
        self.assertEqual([(x["phase"], x["channels"]) for x in data],
                         [("held", ["1", "2"]), ("conference", ["3", "4", "5"])])

    def test_fresh_snapshot_is_atomic_and_group_readable(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / "snapshot.json"
            cl.publish(target, {"state": "ready", "channels": []})
            self.assertEqual(target.stat().st_mode & 0o777, 0o640)
            cl.publish(target, {"state": "ami_offline"})
            self.assertEqual(json.loads(target.read_bytes())["state"], "ami_offline")
            self.assertEqual(list(Path(temp).iterdir()), [target])

    def test_ami_banner_partial_event_and_header_names(self):
        server, client = socket.socketpair()
        try:
            server.sendall(b"Asterisk Call Manager/5.0.4\r\n\r\nEv")
            ami = cl.Ami(client, lambda item: None)
            server.sendall(b"ent: Hold\r\nUniqueid: 1.2\r\n\r\n")
            self.assertEqual(ami.receive(cl.time.monotonic() + 1), {"event": "Hold", "uniqueid": "1.2"})
        finally:
            server.close()
            client.close()

    def test_dial_metadata_and_hangup(self):
        events = cl.LiveEvents()
        events.consume({"event": "DialBegin", "destuniqueid": "1", "dialstring": "trunk/SIPS:+78005551234@carrier"})
        events.consume({"event": "Hold", "uniqueid": "1"})
        self.assertEqual(events.details["1"]["dialed"], "+78005551234")
        self.assertTrue(events.details["1"]["held"])
        events.consume({"event": "Unhold", "uniqueid": "1"})
        self.assertFalse(events.details["1"]["held"])
        events.consume({"event": "Hangup", "uniqueid": "1"})
        self.assertNotIn("1", events.details)


if __name__ == "__main__":
    unittest.main(verbosity=2)
