// SPDX-FileCopyrightText: 2026 Thomas Bechtold
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Generated with AI for personal use.
// Do NOT upload to extensions.gnome.org (EGO) unless you understand JavaScript
// and can maintain this code.

/* prefs.js
 *
 * Runs in a separate process from the shell, so nothing here may import St,
 * Clutter, Meta or Shell — and nothing in extension.js may import Gtk or Adw.
 * The shared modules (layouts.js, search.js, model.js) import neither side,
 * which is what makes them usable from both.
 */

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {
    ExtensionPreferences, gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

/** An Adw.SwitchRow bound to a boolean key. */
function switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

/** An Adw.SpinRow bound to an integer key. */
function spinRow(settings, key, title, subtitle, lower, upper, step = 1) {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({
            lower, upper, step_increment: step, page_increment: step * 10,
        }),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

/** An Adw.ComboRow over a fixed list of string values. */
function comboRow(settings, key, title, subtitle, values, labels) {
    const row = new Adw.ComboRow({
        title,
        subtitle,
        model: Gtk.StringList.new(labels),
        selected: Math.max(0, values.indexOf(settings.get_string(key))),
    });
    row.connect('notify::selected', () =>
        settings.set_string(key, values[row.selected]));
    settings.connect(`changed::${key}`, () => {
        const index = values.indexOf(settings.get_string(key));
        if (index !== -1 && index !== row.selected)
            row.selected = index;
    });
    return row;
}

export default class WindowGroupsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.add(this._appearancePage(settings));
        window.add(this._behaviourPage(settings));
    }

    _appearancePage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Appearance'),
            icon_name: 'applications-graphics-symbolic',
        });

        const size = new Adw.PreferencesGroup({title: _('Size')});
        size.add(spinRow(settings, 'sidebar-width', _('Sidebar width'),
            _('Width when expanded, in logical pixels'), 140, 600, 10));
        size.add(spinRow(settings, 'compact-width', _('Compact width'),
            _('Width when collapsed to icons'), 32, 160, 2));
        size.add(spinRow(settings, 'sidebar-margin', _('Edge margin'),
            _('Gap between the sidebar and the screen edges'), 0, 40));
        page.add(size);

        const depth = new Adw.PreferencesGroup({
            title: _('Depth'),
            description: _('Whether the sidebar reads as floating above the ' +
                'windows or as part of the layout'),
        });
        depth.add(switchRow(settings, 'blur', _('Frost the background'),
            _('Blur whatever is behind the sidebar')));
        depth.add(spinRow(settings, 'blur-radius', _('Blur radius'),
            null, 0, 200, 4));
        depth.add(comboRow(settings, 'reveal-style', _('Reveal style'),
            _('Swing opens the sidebar like a door in perspective'),
            ['swing', 'slide'], [_('Swing'), _('Slide')]));
        page.add(depth);

        const motion = new Adw.PreferencesGroup({
            title: _('Motion'),
            description: _('Ignored while the system “reduce animation” ' +
                'setting is on, which makes every transition instant'),
        });
        motion.add(spinRow(settings, 'animation-duration',
            _('Animation duration'),
            _('Base length in milliseconds; revealing is slightly longer'),
            0, 2000, 20));
        motion.add(spinRow(settings, 'hide-delay', _('Hide delay'),
            _('How long the sidebar waits after the pointer leaves'),
            0, 5000, 50));
        page.add(motion);

        return page;
    }

    _behaviourPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Behaviour'),
            icon_name: 'preferences-system-symbolic',
        });

        const visibility = new Adw.PreferencesGroup({title: _('Visibility')});
        visibility.add(switchRow(settings, 'auto-hide', _('Hide automatically'),
            _('Keep the sidebar off screen until the pointer reaches the ' +
              'left edge. The pin button in the sidebar toggles this too.')));
        visibility.add(switchRow(settings, 'compact', _('Compact'),
            _('Show application icons only')));
        visibility.add(switchRow(settings, 'expand-on-hover',
            _('Expand on hover'),
            _('While compact, expand over the windows when the pointer is ' +
              'on the sidebar')));
        page.add(visibility);

        const layout = new Adw.PreferencesGroup({title: _('Layout')});
        layout.add(spinRow(settings, 'gap', _('Gap between windows'),
            _('Applies to tiled arrangements'), 0, 64, 2));
        layout.add(spinRow(settings, 'outer-gap', _('Gap at the edges'),
            null, 0, 64, 2));
        page.add(layout);

        const groups = new Adw.PreferencesGroup({title: _('Groups')});
        groups.add(switchRow(settings, 'auto-group', _('Group by tag'),
            _('Tagging a window moves it into the group of that name, ' +
              'creating the group if needed')));
        page.add(groups);

        const developer = new Adw.PreferencesGroup({
            title: _('Developer'),
            description: _('Exports a D-Bus interface that reports the ' +
                'extension’s state and can drive it. Used by the test ' +
                'suite; leave off otherwise.'),
        });
        developer.add(switchRow(settings, 'debug-interface',
            _('Debug interface'), null));
        page.add(developer);

        return page;
    }
}
