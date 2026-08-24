#!/usr/bin/env python3
"""Synthesise real keyboard input inside the guest via /dev/uinput.

The VM has a real kernel, so a uinput device is seen by libinput and Mutter
exactly like a physical keyboard. That is the only way to exercise keybindings
and typed input from outside the session — GNOME Shell has no scriptable input
path, and X11 tools only reach XWayland clients.

Must run as root. Usage:

    guest-input.py key super+shift+a
    guest-input.py type "disks"
    guest-input.py key escape
    guest-input.py key super+shift+a type "disk" key down key return
    guest-input.py move 20,400 sleep 1        # hover the sidebar
    guest-input.py move 20,400 click left
    guest-input.py move 0,400 sleep 0.5 rel 200,0   # nudge without re-homing
"""
import ctypes
import fcntl
import os
import struct
import sys
import time

UINPUT = "/dev/uinput"

EV_SYN, EV_KEY, EV_REL = 0x00, 0x01, 0x02
SYN_REPORT = 0
REL_X, REL_Y = 0x00, 0x01
BTN_LEFT, BTN_RIGHT = 0x110, 0x111

UI_DEV_CREATE = 0x5501
UI_DEV_DESTROY = 0x5502
UI_DEV_SETUP = 0x405C5503          # _IOW('U', 3, sizeof(uinput_setup))
UI_SET_EVBIT = 0x40045564          # _IOW('U', 100, int)
UI_SET_KEYBIT = 0x40045565         # _IOW('U', 101, int)
UI_SET_RELBIT = 0x40045566         # _IOW('U', 102, int)

KEYS = {
    "esc": 1, "escape": 1, "1": 2, "2": 3, "3": 4, "4": 5, "5": 6, "6": 7,
    "7": 8, "8": 9, "9": 10, "0": 11, "minus": 12, "equal": 13,
    "backspace": 14, "tab": 15,
    "q": 16, "w": 17, "e": 18, "r": 19, "t": 20, "y": 21, "u": 22, "i": 23,
    "o": 24, "p": 25, "enter": 28, "return": 28, "ctrl": 29,
    "a": 30, "s": 31, "d": 32, "f": 33, "g": 34, "h": 35, "j": 36, "k": 37,
    "l": 38, "semicolon": 39, "shift": 42, "alt": 56, "capslock": 58,
    "z": 44, "x": 45, "c": 46, "v": 47, "b": 48, "n": 49, "m": 50,
    "comma": 51, "dot": 52, "slash": 53, "space": 57,
    "f1": 59, "f2": 60, "f3": 61, "f4": 62, "f5": 63, "f6": 64,
    "f7": 65, "f8": 66, "f9": 67, "f10": 68, "f11": 87, "f12": 88,
    "home": 102, "up": 103, "left": 105, "right": 106, "end": 107, "down": 108,
    "super": 125, "meta": 125,
}


class UinputSetup(ctypes.Structure):
    _fields_ = [
        ("bustype", ctypes.c_uint16),
        ("vendor", ctypes.c_uint16),
        ("product", ctypes.c_uint16),
        ("version", ctypes.c_uint16),
        ("name", ctypes.c_char * 80),
        ("ff_effects_max", ctypes.c_uint32),
    ]


class Keyboard:
    def __enter__(self):
        self.fd = os.open(UINPUT, os.O_WRONLY | os.O_NONBLOCK)
        # Two devices, not one. libinput classifies a device that declares a
        # full keyboard *and* relative axes as a keyboard and never gives it a
        # pointer, so motion from a hybrid device goes nowhere.
        self.fd = self._make(
            b"window-groups test keyboard",
            keys=set(KEYS.values()), rel=False)
        self.pfd = self._make(
            b"window-groups test pointer",
            keys={BTN_LEFT, BTN_RIGHT}, rel=True)
        # libinput has to notice the new devices and the compositor has to add
        # them to its seat before anything sent is delivered anywhere.
        time.sleep(1.5)
        return self

    @staticmethod
    def _make(name, keys, rel):
        fd = os.open(UINPUT, os.O_WRONLY | os.O_NONBLOCK)
        fcntl.ioctl(fd, UI_SET_EVBIT, EV_KEY)
        for code in keys:
            fcntl.ioctl(fd, UI_SET_KEYBIT, code)
        if rel:
            fcntl.ioctl(fd, UI_SET_EVBIT, EV_REL)
            fcntl.ioctl(fd, UI_SET_RELBIT, REL_X)
            fcntl.ioctl(fd, UI_SET_RELBIT, REL_Y)
        setup = UinputSetup(bustype=0x03, vendor=0x1234,
                            product=0x5678 if not rel else 0x5679,
                            version=1, name=name, ff_effects_max=0)
        fcntl.ioctl(fd, UI_DEV_SETUP, setup)
        fcntl.ioctl(fd, UI_DEV_CREATE)
        return fd

    def __exit__(self, *_exc):
        for fd in (self.fd, self.pfd):
            fcntl.ioctl(fd, UI_DEV_DESTROY)
            os.close(fd)

    def _emit(self, etype, code, value, fd=None):
        os.write(fd if fd is not None else self.fd,
                 struct.pack("llHHi", 0, 0, etype, code, value))

    def _sync(self, fd=None):
        self._emit(EV_SYN, SYN_REPORT, 0, fd)

    def tap(self, combo):
        names = [n.strip().lower() for n in combo.split("+") if n.strip()]
        codes = []
        for name in names:
            if name not in KEYS:
                raise SystemExit(f"unknown key: {name}")
            codes.append(KEYS[name])
        for code in codes:
            self._emit(EV_KEY, code, 1)
            self._sync()
        for code in reversed(codes):
            self._emit(EV_KEY, code, 0)
            self._sync()
        time.sleep(0.12)

    def move_rel(self, dx, dy):
        """Move in small steps: one huge jump can be coalesced or clamped,
        and hover logic wants real motion to react to."""
        steps = min(max(abs(dx), abs(dy), 1), 60)
        # Round per step and the remainder is lost: 248 in 60 steps emits
        # 4 each, landing on 240. Track what has actually been sent and take
        # the difference each time so the total is exact.
        sent_x = sent_y = 0
        for i in range(steps):
            want_x = round(dx * (i + 1) / steps)
            want_y = round(dy * (i + 1) / steps)
            self._emit(EV_REL, REL_X, want_x - sent_x, self.pfd)
            self._emit(EV_REL, REL_Y, want_y - sent_y, self.pfd)
            self._sync(self.pfd)
            sent_x, sent_y = want_x, want_y
            time.sleep(0.004)
        time.sleep(0.05)

    def move_to(self, x, y):
        """Fling to the top-left corner first, then step out to (x, y).
        Relative devices have no notion of position, so the corner is the
        only reference point available."""
        self.move_rel(-20000, -20000)
        time.sleep(0.15)
        self.move_rel(x, y)

    def click(self, button="left"):
        code = BTN_LEFT if button == "left" else BTN_RIGHT
        self._emit(EV_KEY, code, 1, self.pfd)
        self._sync(self.pfd)
        time.sleep(0.05)
        self._emit(EV_KEY, code, 0, self.pfd)
        self._sync(self.pfd)
        time.sleep(0.15)

    def type_text(self, text):
        for ch in text:
            if ch == " ":
                self.tap("space")
            elif ch.lower() in KEYS:
                self.tap(ch.lower() if not ch.isupper() else f"shift+{ch.lower()}")
            else:
                raise SystemExit(f"cannot type character: {ch!r}")


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__, file=sys.stderr)
        return 2
    with Keyboard() as kb:
        i = 0
        while i < len(args):
            verb = args[i]
            if verb == "key":
                kb.tap(args[i + 1])
            elif verb == "type":
                kb.type_text(args[i + 1])
            elif verb == "move":
                x, y = args[i + 1].split(",")
                kb.move_to(int(x), int(y))
            elif verb == "rel":
                # No fling to the corner first, so a nudge stays a nudge.
                # move_to costs ~0.75s, which is long enough to expire
                # timeouts the thing under test is meant to be measuring.
                dx, dy = args[i + 1].split(",")
                kb.move_rel(int(dx), int(dy))
            elif verb == "click":
                kb.click(args[i + 1])
            elif verb == "sleep":
                time.sleep(float(args[i + 1]))
            else:
                raise SystemExit(f"unknown verb: {verb}")
            i += 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
