import importlib.util
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("guest_operator", Path(__file__).with_name("operator.py"))
operator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(operator)


class Refusal(unittest.TestCase):
    def setUp(self):
        mocks = self.enterContext(ExitStack())
        mocks.enter_context(patch.object(operator, "VUID", 968, create=True))
        self.census = mocks.enter_context(patch.object(operator, "census"))
        self.attrs = mocks.enter_context(patch.object(operator, "attrs"))
        self.open = mocks.enter_context(patch.object(operator.os, "pidfd_open", return_value=100))
        self.close = mocks.enter_context(patch.object(operator.os, "close"))
        self.signal = mocks.enter_context(patch.object(operator.signal, "pidfd_send_signal"))
        mocks.enter_context(patch.object(operator.select, "select", side_effect=AssertionError))
        self.run = mocks.enter_context(patch.object(operator, "run"))
        self.target = dict(instance=True, pid=42, uid=968, cmdline=["serve"], cgroup="unit", starttime="1")
        self.census.return_value = [self.target]

    def test_refuses_missing_or_ambiguous_target(self):
        for count in (0, 2):
            with self.subTest(count=count):
                self.census.return_value = [self.target] * count
                report, rc = operator.kill_instance()
                self.assertEqual((rc, report["action"]), (2, f"refused: {count} identified instances"))
                self.open.assert_not_called()
                self.signal.assert_not_called()

    def test_exit_before_pidfd_open(self):
        self.open.side_effect = ProcessLookupError
        report, rc = operator.kill_instance()
        self.assertEqual((rc, report["action"]), (2, "refused: target exited before pidfd open"))
        self.signal.assert_not_called()
        self.close.assert_not_called()

    def test_exit_during_recheck(self):
        self.attrs.side_effect = FileNotFoundError
        report, rc = operator.kill_instance()
        self.assertEqual((rc, report["action"]), (2, "refused: target exited before the signal"))
        self.signal.assert_not_called()
        self.close.assert_called_once_with(100)

    def test_identity_changed(self):
        self.attrs.return_value = self.target | {"starttime": "2"}
        report, rc = operator.kill_instance()
        self.assertEqual((rc, report["action"]), (2, "refused: identity changed between census and pidfd"))
        self.signal.assert_called_once_with(100, 0)
        self.close.assert_called_once_with(100)

    def test_manager_exits_during_identification(self):
        self.run.return_value = SimpleNamespace(stdout="MainPID=42\nActiveState=active")
        self.attrs.side_effect = ProcessLookupError
        report, rc = operator.restart_manager()
        self.assertEqual((rc, report["action"]), (2, "refused: manager exited during identification"))
        self.assertEqual([c.args[1] for c in self.run.call_args_list], ["show"])


if __name__ == "__main__":
    unittest.main()
