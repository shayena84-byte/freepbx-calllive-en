import pathlib
import re
import unittest


SCRIPT = pathlib.Path(__file__).parents[1] / "calllive" / "assets" / "js" / "calllive.js"


class FrontendVisibilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = SCRIPT.read_text(encoding="utf-8")

    def test_visibility_handler_is_registered_once(self):
        self.assertEqual(self.source.count("document.addEventListener('visibilitychange'"), 1)

    def test_visible_and_hidden_poll_intervals_are_declared(self):
        self.assertIn("snapshot: {visible: 1000, hidden: 15000}", self.source)
        self.assertIn("entity: {visible: 10000, hidden: 30000}", self.source)
        self.assertIn("record: {visible: 5000, hidden: 15000}", self.source)

    def test_return_to_tab_requests_an_immediate_refresh(self):
        self.assertIn("scheduleRefresh(visible ? 0 : pagePollDelay('snapshot'))", self.source)
        self.assertNotIn("window.setTimeout(refresh, 1000)", self.source)
        self.assertRegex(self.source, re.compile(r"if \(refreshInFlight\).*?refreshAfterCurrent = true", re.S))


if __name__ == "__main__":
    unittest.main()
