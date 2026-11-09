import importlib.util
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1] / 'calllive/deploy'
sys.path.insert(0, str(SOURCE))
import collector as cl
from telemetry import Journal, quality


def channel(uid, linked='root', rtp=None):
    return dict(id=uid, linked=linked, name='PJSIP/' + ('carrier' if uid == 'b' else '201') + '-0000000' + uid,
                bridge='bridge', state='up', app='dial', held=False, age=10, caller='201',
                caller_name='Test caller', connected='+78005551234', rtp=rtp)


def data(now, channels=None, groups=None):
    return dict(state='ready', channels=channels or [], groups=groups or [], hints=[],
                daily=dict(date=datetime.fromtimestamp(now).date().isoformat(), peak=1, longest=15))


def rtp(now, lost=0):
    return dict(rx_packets=200, tx_packets=200, rx_lost=0, tx_lost=lost,
                rx_jitter_ms=5, rtt_ms=20, sampled_at=int(now))


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name)
        self.now = int(datetime.now().replace(hour=12, minute=0, second=0, microsecond=0).timestamp())
        self.j = Journal(self.path, cl.write_json)

    def tearDown(self):
        self.temp.cleanup()

    def connect(self, now=None):
        now = self.now if now is None else now
        self.j.consume(dict(event='Newchannel', linkedid='root', uniqueid='a', channel='PJSIP/201-0000000a',
                            calleridnum='201', secret='NEVER_SAVE_THIS'), now)
        d = data(now, [channel('a', rtp=rtp(now)), channel('b', rtp=rtp(now, 5))],
                 [dict(phase='connected', channels=['a', 'b'], age=10)])
        self.j.observe(d, now)
        return d['groups'][0]['call_id']

    def end(self, now):
        for uid in ('a', 'b'):
            self.j.consume(dict(event='Hangup', linkedid='root', uniqueid=uid, channel=channel(uid)['name'],
                                cause='16', **{'cause-txt': 'Normal Clearing'}), now)
        self.j.observe(data(now), now)
        self.j.observe(data(now + 5), now + 5)

    def test_quality_formula_and_missing_values(self):
        self.assertEqual(quality(rtp(self.now))['score'], 100)
        self.assertEqual(quality(rtp(self.now, 5))['score'], 76)
        self.assertEqual(quality(dict(rtp(self.now), tx_lost=10, rx_jitter_ms=60, rtt_ms=475))['score'], 13)
        self.assertIsNone(quality(dict(rtp(self.now), rx_lost=None, tx_lost=None)))
        self.assertTrue(quality(dict(rtp(self.now), rx_lost=None))['partial'])
        self.assertEqual(quality(dict(rtp(self.now), rtt_ms=800))['score'], 0)

    def test_history_details_causes_search_metadata_and_permissions(self):
        identifier = self.connect()
        for kind in ('Hold', 'Unhold', 'QueueCallerJoin', 'QueueCallerLeave', 'BlindTransfer'):
            self.j.consume(dict(event=kind, linkedid='root', uniqueid='a', queue='600', exten='202'), self.now + 1)
        self.end(self.now + 10)
        self.assertFalse(self.j.active)
        path = self.j.detail_path(identifier)
        record = json.loads(path.read_text())
        self.assertEqual(record['id'], identifier)
        self.assertEqual(record['status'], 'completed')
        self.assertEqual(record['worst_quality']['score'], 76)
        self.assertEqual(len(record['causes']), 2)
        self.assertIn('blindtransfer', [e['kind'] for e in record['timeline']])
        self.assertNotIn('NEVER_SAVE_THIS', path.read_text())
        self.assertEqual(path.stat().st_mode & 0o777, 0o640)
        summary = json.loads((path.parent / 'catalog.jsonl').read_text())
        self.assertIn('+78005551234', summary['numbers'])
        self.assertIn('PJSIP/carrier', summary['endpoints'])
        restored = Journal(self.path, cl.write_json)
        self.assertEqual(restored.detail_path(identifier).read_bytes(), path.read_bytes())
        day = datetime.fromtimestamp(self.now).date().isoformat()
        self.assertEqual(restored.stats[day]['calls'], 1)
        self.assertEqual(restored.stats[day]['answered'], 1)

    def test_restart_keeps_id_and_marks_observation_gap(self):
        identifier = self.connect()
        self.j.flush(self.now, force=True)
        self.j = Journal(self.path, cl.write_json)
        d = data(self.now + 100, [channel('a'), channel('b')], [dict(phase='connected', channels=['a', 'b'], age=110)])
        self.j.observe(d, self.now + 100)
        self.assertEqual(d['groups'][0]['call_id'], identifier)
        record = self.j.active[identifier]
        self.assertTrue(record['gap'])
        self.assertLess(record['talk_seconds'], 10, 'restart gap must not become talk duration')
        self.assertIn('resumed', [e['kind'] for e in record['timeline']])

    def test_disconnect_and_disappeared_call_are_not_fabricated_hangups(self):
        identifier = self.connect()
        self.j.discontinuity(self.now + 3)
        self.j.observe(data(self.now + 100), self.now + 100)
        record = json.loads(self.j.detail_path(identifier).read_text())
        self.assertEqual(record['status'], 'interrupted')
        self.assertTrue(record['gap'])
        self.assertEqual(record['causes'], [])
        self.assertLess(record['talk_seconds'], 10)

    def test_retention_and_disk_limit_are_visible(self):
        old = self.j.archive / (datetime.now().date() - timedelta(days=40)).isoformat()
        old.mkdir(); (old / 'old.json').write_text('{}')
        self.j.next_cleanup = 0
        self.j.cleanup(self.now)
        self.assertFalse(old.exists())
        identifier = self.connect()
        self.j.max_bytes = 1
        self.end(self.now + 10)
        self.assertFalse(self.j.detail_path(identifier).exists())
        self.assertEqual(self.j.view()['capacity_drops'], 1)
        self.assertFalse(self.j.active)

    def test_stale_samples_are_missing_and_decimation_keeps_worst(self):
        identifier = self.connect()
        record = self.j.active[identifier]
        for i in range(1, 1500):
            now = self.now + 5 * i
            for c in record['channels'].values(): c['rtp'] = rtp(now, 20 if i == 200 else 0)
            self.j.sample(record, now)
        self.assertLessEqual(len(record['samples']), 720)
        self.assertEqual(record['worst_quality']['score'], 0)
        self.assertIn(0, [p['score'] for p in record['samples']])
        count = len(record['samples'])
        self.j.sample(record, self.now + 100000)
        self.assertEqual(len(record['samples']), count)

    def test_midnight_and_short_bridge_events_peak(self):
        late = datetime.now().replace(hour=23, minute=59, second=58, microsecond=0).timestamp()
        self.connect(late)
        groups = [dict(phase='connected', channels=['a', 'b'], age=10)]
        chans = {'a': channel('a'), 'b': channel('b')}
        self.j.peaks(groups, chans, late + .5, None)
        self.j.peaks([], {}, late + 1, None)
        self.assertGreater(self.j.active[next(iter(self.j.active))]['talk_seconds'], 0)
        following = data(late + 4); following['daily']['peak'] = 0
        self.j.observe(following, late + 4)
        today, tomorrow = datetime.fromtimestamp(late).date().isoformat(), datetime.fromtimestamp(late + 4).date().isoformat()
        self.assertEqual(self.j.stats[today]['peak'], 1)
        self.assertEqual(self.j.stats[tomorrow]['peak'], 0)
        self.assertEqual(self.j.stats[today]['endpoints']['PJSIP/carrier'], 1)

    def test_transfer_fields_without_standard_uniqueid(self):
        identifier = self.connect()
        self.j.consume(dict(event='BlindTransfer', transfereruniqueid='a', extension='202', result='Success'), self.now + 2)
        self.j.consume(dict(event='AttendedTransfer', origtransfereruniqueid='a', destexten='203', result='Success'), self.now + 3)
        events = self.j.active[identifier]['timeline']
        self.assertEqual([e['target'] for e in events if e['kind'] in ('blindtransfer','attendedtransfer')], ['202','203'])

    def test_storage_error_does_not_stop_live_state(self):
        identifier = self.connect()
        def broken(*args): raise OSError('test read-only disk')
        self.j.writer = broken
        self.j.flush(self.now + 1, force=True)
        self.assertTrue(self.j.view()['storage_error'])
        self.assertIn(identifier, self.j.active)


if __name__ == '__main__':
    unittest.main(verbosity=2)
