#!/usr/bin/env python3
# DEVELOP-VERIFY-TRUST-004 serial console for a human operator (Amendment 4), under the operator's own uid. No listener, no network.
#   attach.py     guest console output to this terminal and appended to vm/console.log; keystrokes, Ctrl-C included, to the guest.
#                 Ctrl-] detaches. Exits when QEMU closes the console.
# One reader drains vm/con.out: attach holds an exclusive lock on console.log and refuses to start without it. While nobody is
# attached, console output waits in the pipe; reattaching drains it. console.py can still run single commands while attached.
import errno
import fcntl
import os
import select
import sys
import termios
import tty

W = os.path.join(os.environ.get("ENDO13_WORK", os.path.expanduser("~/.capy/work/endo13")), "vm")
DETACH = b"\x1d"


def say(message):
    os.write(sys.stderr.fileno(), f"\r\n[attach] {message}\r\n".encode())


def write_all(fd, data):
    while data:
        select.select([], [fd], [])
        try:
            data = data[os.write(fd, data):]
        except BlockingIOError:
            continue


def relay(guest_in, guest_out, log, stdin):
    while True:
        ready = select.select([guest_out, stdin], [], [])[0]
        if guest_out in ready:
            try:
                data = os.read(guest_out, 65536)
            except BlockingIOError:
                data = None
            if data == b"":
                say("guest console closed")
                return 0
            if data:
                log.write(data)
                log.flush()
                write_all(sys.stdout.fileno(), data)
        if stdin in ready:
            data = os.read(stdin, 1024)
            if not data or DETACH in data:
                write_all(guest_in, data.split(DETACH)[0])
                say("detached; guest output waits in the pipe until the next attach")
                return 0
            write_all(guest_in, data)


def main():
    log = open(os.path.join(W, "console.log"), "ab")
    try:
        fcntl.flock(log, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        say("another console reader holds console.log")
        return 75
    try:
        guest_in = os.open(os.path.join(W, "con.in"), os.O_WRONLY | os.O_NONBLOCK)
    except OSError as e:
        if e.errno != errno.ENXIO:
            raise
        say("no guest is reading con.in; is QEMU running?")
        return 69
    guest_out = os.open(os.path.join(W, "con.out"), os.O_RDONLY | os.O_NONBLOCK)
    stdin = sys.stdin.fileno()
    saved = termios.tcgetattr(stdin) if os.isatty(stdin) else None
    if saved is not None:
        tty.setraw(stdin)
    say(f"attached to {W}; Ctrl-] detaches")
    try:
        return relay(guest_in, guest_out, log, stdin)
    finally:
        if saved is not None:
            termios.tcsetattr(stdin, termios.TCSADRAIN, saved)


if __name__ == "__main__":
    sys.exit(main())
