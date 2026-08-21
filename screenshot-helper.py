#!/usr/bin/env python3
"""Take a screenshot of a sandboxed GNOME Shell over its own session bus.

gnome-shell's Screenshot D-Bus method is restricted to callers that own
either org.gnome.SettingsDaemon.MediaKeys or
org.freedesktop.impl.portal.desktop.gnome (see ui/screenshot.js,
DBusSenderChecker). In a sandbox session gsd-media-keys is not running, so
we can legitimately own the media-keys name and call from there.

Usage: screenshot-helper.py OUTPUT.png
"""
import sys

from gi.repository import Gio, GLib  # type: ignore[attr-defined]

BUS_NAME = "org.gnome.SettingsDaemon.MediaKeys"


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    output = sys.argv[1]

    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    loop = GLib.MainLoop()
    status = {"code": 1}

    def on_name_acquired(connection, name):
        try:
            result = connection.call_sync(
                "org.gnome.Shell",
                "/org/gnome/Shell/Screenshot",
                "org.gnome.Shell.Screenshot",
                "Screenshot",
                GLib.Variant("(bbs)", (False, False, output)),
                GLib.VariantType("(bs)"),
                Gio.DBusCallFlags.NONE,
                30000,
                None,
            )
            success, filename = result.unpack()
            if success:
                print(filename)
                status["code"] = 0
            else:
                print("screenshot reported failure", file=sys.stderr)
        except GLib.Error as err:
            print(f"screenshot failed: {err.message}", file=sys.stderr)
        finally:
            loop.quit()

    def on_name_lost(connection, name):
        print(f"could not own {BUS_NAME}", file=sys.stderr)
        loop.quit()

    Gio.bus_own_name_on_connection(
        bus,
        BUS_NAME,
        Gio.BusNameOwnerFlags.NONE,
        on_name_acquired,
        on_name_lost,
    )
    loop.run()
    return status["code"]


if __name__ == "__main__":
    sys.exit(main())
