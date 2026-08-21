#!/usr/bin/env python3
"""Set the guest monitor's scale (and optionally mode) via Mutter's
org.gnome.Mutter.DisplayConfig.

When remote-viewer connects, the SPICE agent resizes the VM's virtual monitor
to the client window size. That can land on a very large mode at scale 1.0,
which makes the whole desktop microscopic. This applies a proper HiDPI scale
instead of shrinking the resolution, so you keep the working area.

Usage: guest-display.py <scale> [WIDTHxHEIGHT]
       guest-display.py --list
"""
import sys

from gi.repository import Gio, GLib  # type: ignore[attr-defined]

DEST = "org.gnome.Mutter.DisplayConfig"
PATH = "/org/gnome/Mutter/DisplayConfig"


def get_state(bus):
    return bus.call_sync(
        DEST, PATH, DEST, "GetCurrentState", None,
        GLib.VariantType("(ua((ssss)a(siiddada{sv})a{sv})a(iiduba(ssss)a{sv})a{sv})"),
        Gio.DBusCallFlags.NONE, 10000, None,
    ).unpack()


def main() -> int:
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    serial, monitors, logical, _props = get_state(bus)

    if not monitors:
        print("no monitors reported", file=sys.stderr)
        return 1

    (connector, vendor, product, _serial_no), modes, _mprops = monitors[0]

    if len(sys.argv) > 1 and sys.argv[1] == "--list":
        print(f"{connector} ({vendor} {product})")
        for mode_id, w, h, refresh, _pref_scale, scales, props in modes:
            mark = " *" if props.get("is-current") else ""
            print(f"  {mode_id:<24} {w}x{h}  scales={[round(s, 3) for s in scales]}{mark}")
        return 0

    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2

    want_scale = float(sys.argv[1])
    want_mode = sys.argv[2] if len(sys.argv) > 2 else None

    chosen = None
    for mode in modes:
        mode_id, w, h, _refresh, _pref, scales, props = mode
        if want_mode:
            if f"{w}x{h}" != want_mode:
                continue
        elif not props.get("is-current"):
            continue
        if not any(abs(s - want_scale) < 0.01 for s in scales):
            available = [round(s, 3) for s in scales]
            print(f"mode {w}x{h} does not support scale {want_scale}; "
                  f"supported: {available}", file=sys.stderr)
            return 1
        chosen = (mode_id, w, h)
        break

    if chosen is None:
        print("no matching mode", file=sys.stderr)
        return 1

    mode_id, w, h = chosen
    # (serial, persistent, [(x, y, scale, transform, primary,
    #                        [(connector, mode_id, properties)])], properties)
    config = GLib.Variant(
        "(uua(iiduba(ssa{sv}))a{sv})",
        (serial, 1,
         [(0, 0, want_scale, 0, True, [(connector, mode_id, {})])],
         {}),
    )
    bus.call_sync(DEST, PATH, DEST, "ApplyMonitorsConfig", config, None,
                  Gio.DBusCallFlags.NONE, 10000, None)
    print(f"{connector}: {w}x{h} @ scale {want_scale} "
          f"(logical {int(w / want_scale)}x{int(h / want_scale)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
