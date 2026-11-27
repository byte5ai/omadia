"""#1813 — exit codes of the pinned skillspector commit.

Run from the repo root:
    PYTHONPATH=middleware/sidecars/skillspector python3 -m unittest middleware/sidecars/skillspector/test_server.py
"""

import json
import subprocess
import unittest
from unittest import mock

import server

REPORT_HIGH = {
    "risk_assessment": {"score": 100, "severity": "CRITICAL"},
    "issues": [
        {"id": "MP-1", "severity": "HIGH", "explanation": "memory poisoning",
         "location": {"file": "manifest.yaml"}},
    ],
}


def fake_run(returncode: int, stdout: str, stderr: str = ""):
    return mock.patch.object(
        server.subprocess, "run",
        return_value=subprocess.CompletedProcess([], returncode, stdout, stderr),
    )


class RunScanExitCodes(unittest.TestCase):
    def setUp(self):
        version = mock.patch.object(server, "skillspector_version", return_value="SkillSpector test")
        version.start()
        self.addCleanup(version.stop)

    def test_exit_1_with_report_is_a_completed_high_risk_scan(self):
        with fake_run(1, json.dumps(REPORT_HIGH)):
            out = server.run_scan([])
        self.assertTrue(out["ok"])
        self.assertEqual(out["findings"][0]["severity"], "HIGH")

    def test_exit_1_without_issues_is_a_failure(self):
        with fake_run(1, json.dumps({"issues": [], "risk_assessment": {"score": 0}})):
            out = server.run_scan([])
        self.assertFalse(out["ok"])

    def test_exit_2_is_a_failure(self):
        with fake_run(2, "", "path not found"):
            out = server.run_scan([])
        self.assertFalse(out["ok"])
        self.assertIn("exited 2", out["error"])

    def test_exit_0_clean(self):
        with fake_run(0, json.dumps({"issues": [], "risk_assessment": {"score": 0}})):
            out = server.run_scan([])
        self.assertTrue(out["ok"])
        self.assertEqual(out["findings"], [])


if __name__ == "__main__":
    unittest.main()
