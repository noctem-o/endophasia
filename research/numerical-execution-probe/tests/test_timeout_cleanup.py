"""Offline process fixtures: no model is opened by the synthetic executable."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import probe

CONTROLLER = r'''
import json, signal, subprocess, sys
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, sys.argv[1])
import probe
root = Path(sys.argv[2]); mode = sys.argv[3]
timeout = 5 if mode == 'interrupt' else 1 if mode in ('success', 'verification_failure', 'escaped_closed_pipes') else 0.25
backend = probe.NativeBackend(root / 'native', root / 'model', timeout)
if mode == 'interrupt':
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    signal.setitimer(signal.ITIMER_REAL, 0.25)
try:
    if mode == 'cleanup_failure':
        with patch.object(probe, 'reap_owned_group', side_effect=RuntimeError('synthetic cleanup failure')):
            result = backend.evaluate('A1', (1, 2), dict(context=512,batch=32,ubatch=32,threads=1), root/'pids')
    elif mode == 'direct_reap_failure':
        with patch.object(probe.subprocess.Popen, 'wait', side_effect=subprocess.TimeoutExpired('native', 0)):
            result = backend.evaluate('A1', (1, 2), dict(context=512,batch=32,ubatch=32,threads=1), root/'pids')
    elif mode == 'verification_failure':
        with patch.object(probe, 'no_adopted_children', side_effect=OSError('synthetic verification failure')):
            result = backend.evaluate('A1', (1, 2), dict(context=512,batch=32,ubatch=32,threads=1), root/'pids')
    else:
        result = backend.evaluate('A1', (1, 2), dict(context=512,batch=32,ubatch=32,threads=1), root/'pids')
    outcome = {'result': result}
except BaseException as exc:
    outcome = {'error': type(exc).__name__, 'message': str(exc)}
finally:
    signal.setitimer(signal.ITIMER_REAL, 0)
outcome['observation'] = backend.last_observation
print(json.dumps(outcome))
'''


@unittest.skipUnless(sys.platform == 'linux', 'Linux subreaping and process groups required')
class TimeoutCleanupTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Adopt any escaped synthetic descendants after their controller exits.
        probe.enable_child_subreaper()

    @staticmethod
    def child_ids():
        # This serial test process creates no other children during a fixture.
        return {int(pid) for pid in Path(f"/proc/self/task/{os.getpid()}/children").read_text().split()}

    def run_fixture(self, mode):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / 'model').write_bytes(b'not a model')
            native = root / 'native'
            native.write_text('''#!/usr/bin/python3
import json, os, subprocess, sys, time
mode = %r
pids = {'direct': os.getpid()}
if mode in ('same_group', 'escaped', 'escaped_after_exit', 'escaped_closed_pipes'):
    child = subprocess.Popen(['/usr/bin/python3', '-c', 'import time; time.sleep(30)'],
                             start_new_session=mode != 'same_group',
                             stdout=subprocess.DEVNULL if mode == 'escaped_closed_pipes' else None,
                             stderr=subprocess.DEVNULL if mode == 'escaped_closed_pipes' else None)
    pids['descendant'] = child.pid
open(sys.argv[sys.argv.index('--output') + 1], 'w').write(json.dumps(pids))
if mode in ('success', 'escaped_closed_pipes', 'verification_failure'):
    print(json.dumps({'synthetic': True}), flush=True)
elif mode == 'escaped_after_exit':
    os._exit(0)
elif mode == 'partial_output':
    print('{"unfinished":', end='', flush=True)
    time.sleep(30)
else:
    time.sleep(30)
''' % mode)
            native.chmod(0o700)
            before = self.child_ids()
            controller = subprocess.Popen([sys.executable, '-c', CONTROLLER, str(ROOT), str(root), mode],
                                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            start = time.monotonic()
            try:
                stdout, stderr = controller.communicate(timeout=3)
                elapsed = time.monotonic() - start
                self.assertEqual(controller.returncode, 0, stderr)
                result = json.loads(stdout)
                self.assertLess(elapsed, 1.75, mode)
                return result, elapsed
            finally:
                if controller.poll() is None:
                    controller.kill()
                    controller.wait(timeout=2)
                # Sweep newly adopted children even if the controller was killed
                # between spawning a descendant and writing its PID ledger.
                deadline = time.monotonic() + 2
                while self.child_ids() - before:
                    for pid in self.child_ids() - before:
                        try:
                            state = os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                        except ChildProcessError:
                            continue
                        if state is None:
                            os.kill(pid, signal.SIGKILL)
                        try:
                            os.waitpid(pid, os.WNOHANG)
                        except ChildProcessError:
                            pass
                    if time.monotonic() >= deadline:
                        self.fail('synthetic children could not be reaped')
                    time.sleep(0.01)

    def test_immediate_success(self):
        result, _ = self.run_fixture('success')
        self.assertEqual(result['result'], {'synthetic': True})
        self.assertTrue(result['observation']['direct_child_reaped'])
        self.assertEqual(result['observation']['descendant_containment'], 'established')

    def test_hung_direct_child_and_same_group_descendant(self):
        for mode in ('hung', 'same_group', 'partial_output'):
            with self.subTest(mode=mode):
                result, _ = self.run_fixture(mode)
                self.assertEqual(result['observation']['termination'], 'timeout')
                self.assertTrue(result['observation']['direct_child_reaped'])
                self.assertEqual(result['observation']['descendant_containment'], 'established')

    def test_escaped_descendant_holding_pipes_is_bounded_and_uncertain(self):
        for mode in ('escaped', 'escaped_after_exit'):
            with self.subTest(mode=mode):
                result, _ = self.run_fixture(mode)
                self.assertEqual(result['observation']['termination'], 'timeout')
                self.assertTrue(result['observation']['direct_child_reaped'])
                self.assertEqual(result['observation']['descendant_containment'], 'uncertain')

    def test_interruption_during_output_collection(self):
        result, _ = self.run_fixture('interrupt')
        self.assertEqual(result['error'], 'KeyboardInterrupt')
        self.assertEqual(result['observation']['termination'], 'interrupted')
        self.assertTrue(result['observation']['direct_child_reaped'])
        self.assertEqual(result['observation']['descendant_containment'], 'established')

    def test_cleanup_failure_is_uncertain_and_fails(self):
        result, _ = self.run_fixture('cleanup_failure')
        self.assertEqual(result['error'], 'RuntimeError')
        self.assertTrue(result['observation']['direct_child_reaped'])
        self.assertEqual(result['observation']['descendant_containment'], 'uncertain')

    def test_direct_reap_failure_is_reported_separately(self):
        result, _ = self.run_fixture('direct_reap_failure')
        self.assertEqual(result['error'], 'RuntimeError')
        self.assertFalse(result['observation']['direct_child_reaped'])
        self.assertEqual(result['observation']['descendant_containment'], 'uncertain')

    def test_unavailable_containment_verification_fails_closed(self):
        result, _ = self.run_fixture('verification_failure')
        self.assertEqual(result['error'], 'RuntimeError')
        self.assertEqual(result['observation']['termination'], 'exited')
        self.assertTrue(result['observation']['direct_child_reaped'])
        self.assertEqual(result['observation']['descendant_containment'], 'uncertain')

    def test_successful_direct_exit_with_escaped_child_still_fails_closed(self):
        result, _ = self.run_fixture('escaped_closed_pipes')
        self.assertEqual(result['error'], 'RuntimeError')
        self.assertEqual(result['observation']['termination'], 'exited')
        self.assertTrue(result['observation']['direct_child_reaped'])
        self.assertEqual(result['observation']['descendant_containment'], 'uncertain')


if __name__ == '__main__':
    unittest.main()
