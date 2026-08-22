/* extension.js
 *
 * Window Groups — a left sidebar of open windows, organised into named,
 * reorderable groups. Each group carries its own arrangement.
 *
 * Groups are backed 1:1 by static workspaces, so Mutter owns showing and
 * hiding windows, session lifetime and XWayland. This extension only ever
 * draws a view and calls into the workspace API.
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {computeLayout, resizeToState} from './layouts.js';
import {rankWindows} from './search.js';
import {Arranger} from './arranger.js';
import {
    padArray, moveItem, removeItem, indexOfName, chooseGroupSlot, contrastOn,
    chooseRehomeTarget, UNGROUPED,
} from './model.js';

const ICON_SIZE = 18;
const COMPACT_ICON_SIZE = 24;
const REVEAL_TIMEOUT = 1000;
const SLIDE_DURATION = 200;
const HIDE_DELAY = 400;
const TOOLTIP_DELAY = 450;
const HOVER_EXPAND_DELAY = 180;
const HOVER_COLLAPSE_DELAY = 300;
const EDGE_DWELL = 250;

/** Every grab op that means "the user resized this window". */
const RESIZE_GRAB_OPS = new Set([
    Meta.GrabOp.RESIZING_N, Meta.GrabOp.RESIZING_S,
    Meta.GrabOp.RESIZING_E, Meta.GrabOp.RESIZING_W,
    Meta.GrabOp.RESIZING_NE, Meta.GrabOp.RESIZING_NW,
    Meta.GrabOp.RESIZING_SE, Meta.GrabOp.RESIZING_SW,
    Meta.GrabOp.KEYBOARD_RESIZING_N, Meta.GrabOp.KEYBOARD_RESIZING_S,
    Meta.GrabOp.KEYBOARD_RESIZING_E, Meta.GrabOp.KEYBOARD_RESIZING_W,
    Meta.GrabOp.KEYBOARD_RESIZING_NE, Meta.GrabOp.KEYBOARD_RESIZING_NW,
    Meta.GrabOp.KEYBOARD_RESIZING_SE, Meta.GrabOp.KEYBOARD_RESIZING_SW,
    Meta.GrabOp.KEYBOARD_RESIZING_UNKNOWN,
]);
const BUTTON_ICON_SIZE = 14;

/** Arrangements a group can use. The geometry lives in layouts.js, which
 *  imports nothing from GNOME and is unit tested separately. */
const ARRANGEMENTS = ['free', 'tabbed', 'columns', 'rows', 'grid', 'master-stack'];

const ARRANGEMENT_ICON = {
    'free': 'window-restore-symbolic',
    'tabbed': 'view-paged-symbolic',
    'columns': 'view-dual-symbolic',
    'rows': 'view-continuous-symbolic',
    'grid': 'view-grid-symbolic',
    'master-stack': 'view-list-symbolic',
};

const ARRANGEMENT_LABEL = {
    'free': 'Free',
    'tabbed': 'Tabbed',
    'columns': 'Columns',
    'rows': 'Rows',
    'grid': 'Grid',
    'master-stack': 'Master + stack',
};

/** Group colours, modelled on Chrome's tab groups, grey first as its default. */
const GROUP_COLORS = [
    {name: 'grey',   hex: '#5f6368'},
    {name: 'blue',   hex: '#4285f4'},
    {name: 'red',    hex: '#ea4335'},
    {name: 'yellow', hex: '#fbbc04'},
    {name: 'green',  hex: '#34a853'},
    {name: 'pink',   hex: '#ff8bcb'},
    {name: 'purple', hex: '#a142f4'},
    {name: 'cyan',   hex: '#24c1e0'},
    {name: 'orange', hex: '#fa903e'},
];

function colorByName(name) {
    return GROUP_COLORS.find(c => c.name === name) ?? GROUP_COLORS[0];
}

/** Windows we put in the sidebar and arrange. Dialogs follow their parent,
 *  docks and panels are not the user's windows. */
function isManagedWindow(win) {
    if (!win || win.is_override_redirect() || win.is_skip_taskbar())
        return false;
    return win.get_window_type() === Meta.WindowType.NORMAL;
}

/* -------------------------------------------------------------------------
 * Model: groups are workspaces
 * ---------------------------------------------------------------------- */

class GroupModel {
    constructor(settings) {
        this._settings = settings;
        this._wmPrefs = new Gio.Settings({
            schema_id: 'org.gnome.desktop.wm.preferences',
        });
    }

    get wmPrefs() {
        return this._wmPrefs;
    }

    destroy() {
        this._settings = null;
        this._wmPrefs = null;
    }

    get count() {
        return global.workspace_manager.get_n_workspaces();
    }

    workspace(index) {
        return global.workspace_manager.get_workspace_by_index(index);
    }

    get activeIndex() {
        return global.workspace_manager.get_active_workspace_index();
    }

    name(index) {
        return this.rawName(index) || `Group ${index + 1}`;
    }

    /** The stored name, empty if the group has never been named. `name()`
     *  substitutes a placeholder; this does not. */
    rawName(index) {
        return this._wmPrefs.get_strv('workspace-names')[index]?.trim() ?? '';
    }

    setName(index, name) {
        const names = this._padded(this._wmPrefs.get_strv('workspace-names'), '');
        names[index] = name.trim();
        this._wmPrefs.set_strv('workspace-names', names);
    }

    arrangement(index) {
        const values = this._settings.get_strv('arrangements');
        return ARRANGEMENTS.includes(values[index]) ? values[index] : 'free';
    }

    setArrangement(index, value) {
        const values = this._padded(this._settings.get_strv('arrangements'), 'free');
        values[index] = value;
        this._settings.set_strv('arrangements', values);
    }

    cycleArrangement(index) {
        const next = (ARRANGEMENTS.indexOf(this.arrangement(index)) + 1) % ARRANGEMENTS.length;
        this.setArrangement(index, ARRANGEMENTS[next]);
        return ARRANGEMENTS[next];
    }

    color(index) {
        return colorByName(this._settings.get_strv('colors')[index]);
    }

    setColor(index, name) {
        const values = this._padded(this._settings.get_strv('colors'), 'grey');
        values[index] = name;
        this._settings.set_strv('colors', values);
    }

    cycleColor(index) {
        const current = GROUP_COLORS.indexOf(this.color(index));
        const next = GROUP_COLORS[(current + 1) % GROUP_COLORS.length];
        this.setColor(index, next.name);
        return next;
    }

    layoutState(index) {
        const raw = this._settings.get_strv('layout-states')[index];
        let parsed = {};
        if (raw) {
            try {
                parsed = JSON.parse(raw) ?? {};
            } catch (e) {
                parsed = {};
            }
        }
        return {
            ...parsed,
            gap: this._settings.get_int('gap'),
            outerGap: this._settings.get_int('outer-gap'),
        };
    }

    setLayoutState(index, state) {
        const values = this._padded(this._settings.get_strv('layout-states'), '{}');
        // Gaps are global; only the per-group parts are stored.
        const {gap: _g, outerGap: _o, ...rest} = state;
        values[index] = JSON.stringify(rest);
        this._settings.set_strv('layout-states', values);
    }

    windows(index) {
        const ws = this.workspace(index);
        if (!ws)
            return [];
        return ws.list_windows()
            .filter(isManagedWindow)
            .sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence());
    }

    indexOfName(name) {
        const names = Array.from({length: this.count}, (_, i) => this.rawName(i));
        return indexOfName(names, name);
    }

    /** Index of the group called `name`, creating or recycling one if needed.
     *  The decision itself lives in model.js and is unit tested. */
    ensureGroupNamed(name, cap) {
        const names = Array.from({length: this.count}, (_, i) => this.rawName(i));
        const windowCounts = names.map((_, i) => this.windows(i).length);
        const {action, index} = chooseGroupSlot({names, windowCounts, name, cap});

        switch (action) {
        case 'existing':
            return index;
        case 'reuse':
            this.setName(index, name);
            return index;
        case 'append': {
            this.addGroup();
            const appended = this.count - 1;
            this.setName(appended, name);
            return appended;
        }
        default:
            return -1;
        }
    }

    addGroup() {
        global.workspace_manager.append_new_workspace(false, global.get_current_time());
    }

    /** Remove a group, rehoming its windows into the group above it. */
    /** Dissolve a group. Its windows are not closed — they move out of any
     *  group, into a fallback created on demand. Dropping them into whichever
     *  group happened to be adjacent silently merged unrelated work. */
    removeGroup(index) {
        const names = Array.from({length: this.count}, (_, i) => this.rawName(i));
        const {action, index: existing} = chooseRehomeTarget({names, removing: index});
        if (action === 'refuse')
            return;

        let target = existing;
        if (action === 'create') {
            target = this.ensureGroupNamed(UNGROUPED, MAX_AUTO_GROUPS);
            if (target === -1)
                return;
        }

        for (const win of this.windows(index))
            win.change_workspace_by_index(target, false);

        this._spliceParallel(index);
        global.workspace_manager.remove_workspace(
            this.workspace(index), global.get_current_time());
    }

    /** Move a group to an arbitrary position. reorder_workspace() has move
     *  semantics — it lifts the workspace out and reinserts it, shifting the
     *  rest — so the parallel arrays must splice rather than swap, or they
     *  desynchronise for any move longer than one step. */
    moveGroupTo(from, to) {
        if (from === to || from < 0 || to < 0 ||
            from >= this.count || to >= this.count)
            return;
        this._moveParallel(from, to);
        global.workspace_manager.reorder_workspace(this.workspace(from), to);
    }

    moveWindowToGroup(win, index) {
        if (win.get_workspace()?.index() !== index)
            win.change_workspace_by_index(index, false);
    }

    _padded(values, fill) {
        return padArray(values, this.count, fill);
    }

    _moveParallel(from, to) {
        const move = (getter, setter, fill) => {
            setter(moveItem(this._padded(getter(), fill), from, to));
        };
        move(() => this._wmPrefs.get_strv('workspace-names'),
            v => this._wmPrefs.set_strv('workspace-names', v), '');
        move(() => this._settings.get_strv('arrangements'),
            v => this._settings.set_strv('arrangements', v), 'free');
        move(() => this._settings.get_strv('colors'),
            v => this._settings.set_strv('colors', v), 'grey');
        move(() => this._settings.get_strv('layout-states'),
            v => this._settings.set_strv('layout-states', v), '{}');
    }

    _spliceParallel(index) {
        const splice = (getter, setter, fill) => {
            setter(removeItem(this._padded(getter(), fill), index));
        };
        splice(() => this._wmPrefs.get_strv('workspace-names'),
            v => this._wmPrefs.set_strv('workspace-names', v), '');
        splice(() => this._settings.get_strv('arrangements'),
            v => this._settings.set_strv('arrangements', v), 'free');
        splice(() => this._settings.get_strv('colors'),
            v => this._settings.set_strv('colors', v), 'grey');
        splice(() => this._settings.get_strv('layout-states'),
            v => this._settings.set_strv('layout-states', v), '{}');
    }
}

/* -------------------------------------------------------------------------
 * Tags
 * ---------------------------------------------------------------------- */

/** Cap on groups the engine will create by itself. */
const MAX_AUTO_GROUPS = 16;

/** One tag per window, held for the lifetime of the session.
 *
 *  Mutter exposes no persistent per-window identity — get_id() and
 *  get_stable_sequence() are both session-scoped — so a tag attached to a
 *  particular window cannot be reattached after a restart. Keying on the
 *  live Meta.Window makes that limit explicit instead of pretending
 *  otherwise.
 */
class TagStore {
    constructor() {
        this._tags = new Map();
    }

    destroy() {
        this._tags.clear();
    }

    tag(win) {
        return this._tags.get(win) ?? '';
    }

    setTag(win, tag) {
        const cleaned = tag.trim();
        if (cleaned)
            this._tags.set(win, cleaned);
        else
            this._tags.delete(win);
    }

    forget(win) {
        this._tags.delete(win);
    }
}

/* -------------------------------------------------------------------------
 * Arranger: applies a group's arrangement
 * ---------------------------------------------------------------------- */

/* -------------------------------------------------------------------------
 * Widgets
 * ---------------------------------------------------------------------- */

/** Hover tooltip. The header is a row of small symbolic icons whose meaning
 *  is not guessable; an accessible_name alone does not help a sighted user. */
function addTooltip(button, text) {
    let label = null;
    let timeoutId = 0;

    const hide = () => {
        if (timeoutId) {
            GLib.source_remove(timeoutId);
            timeoutId = 0;
        }
        label?.destroy();
        label = null;
    };

    button.connect('notify::hover', () => {
        if (!button.hover) {
            hide();
            return;
        }
        timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TOOLTIP_DELAY, () => {
            timeoutId = 0;
            label = new St.Label({style_class: 'wg-tooltip', text});
            Main.layoutManager.addTopChrome(label);
            const [x, y] = button.get_transformed_position();
            label.set_position(
                Math.round(x + button.width + 8),
                Math.round(y + (button.height - label.height) / 2));
            return GLib.SOURCE_REMOVE;
        });
    });
    button.connect('destroy', hide);
}

function iconButton(iconName, tooltip, styleClass = 'wg-icon-button') {
    const button = new St.Button({
        style_class: styleClass,
        can_focus: true,
        track_hover: true,
        accessible_name: tooltip,
        child: new St.Icon({icon_name: iconName, icon_size: BUTTON_ICON_SIZE}),
    });
    addTooltip(button, tooltip);
    return button;
}

const WindowRow = GObject.registerClass(
class WindowRow extends St.Button {
    _init(win, sidebar, color, compact) {
        super._init({
            style_class: 'wg-window-row',
            x_expand: true,
            can_focus: true,
            reactive: true,
        });

        this._win = win;
        this._sidebar = sidebar;
        // DND resolves drop targets by walking up the actor tree looking
        // for a _delegate; ours only acts as a drag *source*.
        this._delegate = this;

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'wg-window-row-content',
            x_expand: true,
            x_align: compact ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.FILL,
        });
        this.set_child(box);

        // Chrome's group membership cue: a short coloured line down the left
        // of every entry in the group.
        if (!compact) {
            const stripe = new St.Widget({style_class: 'wg-group-stripe'});
            stripe.style = `background-color: ${color?.hex ?? GROUP_COLORS[0].hex};`;
            box.add_child(stripe);
        }

        const iconSize = compact ? COMPACT_ICON_SIZE : ICON_SIZE;
        const app = Shell.WindowTracker.get_default().get_window_app(win);
        box.add_child(app
            ? app.create_icon_texture(iconSize)
            : new St.Icon({icon_name: 'application-x-executable-symbolic', icon_size: iconSize}));

        this._label = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            style_class: 'wg-window-title',
        });
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.updateTitle();
        if (compact) {
            // No room for a title, so the tooltip carries it instead.
            this.track_hover = true;
            addTooltip(this, win.get_title() ?? '');
            this.add_style_class_name('wg-compact-row');
        } else {
            box.add_child(this._label);
        }

        this._box = box;
        const tag = compact ? null : sidebar?.tags?.tag(win);
        if (tag) {
            box.add_child(new St.Label({
                text: tag,
                style_class: 'wg-tag-chip',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        this._draggable = DND.makeDraggable(this, {dragActorOpacity: 200});
        this._draggable.connect('drag-begin',
            () => this.add_style_class_name('wg-dragging'));
        this._draggable.connect('drag-end',
            () => this.remove_style_class_name('wg-dragging'));
        this._draggable.connect('drag-cancelled',
            () => this.remove_style_class_name('wg-dragging'));

        this.connect('clicked', () => this._win.activate(global.get_current_time()));
        this.connect('button-press-event', (actor, event) => {
            if (event.get_button() === Clutter.BUTTON_SECONDARY) {
                this._editTags();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _editTags() {
        const tags = this._sidebar?.tags;
        if (!tags)
            return;

        const entry = new St.Entry({
            style_class: 'wg-tag-entry',
            text: tags.tag(this._win),
            x_expand: true,
        });
        this._label.hide();
        this._box.insert_child_at_index(entry, 1);

        const finish = commit => {
            if (commit) {
                tags.setTag(this._win, entry.get_text());
                this._sidebar.applyTag(this._win);
            }
            this._sidebar.queueRebuild();
        };

        entry.clutter_text.connect('activate', () => finish(true));
        entry.clutter_text.connect('key-focus-out', () => finish(false));
        entry.clutter_text.connect('key-press-event', (a, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                finish(false);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        global.stage.set_key_focus(entry.clutter_text);
        entry.clutter_text.set_selection(0, -1);
    }

    get metaWindow() {
        return this._win;
    }

    updateTitle() {
        this._label.text = this._win.get_title() ?? '';
    }

    setFocused(focused) {
        if (focused)
            this.add_style_class_name('wg-focused');
        else
            this.remove_style_class_name('wg-focused');
    }

    getDragActor() {
        return new St.Label({
            text: this._label.text,
            style_class: 'wg-drag-label',
        });
    }

    getDragActorSource() {
        return this;
    }
});

const GroupSection = GObject.registerClass(
class GroupSection extends St.BoxLayout {
    _init(index, model, sidebar, compact) {
        super._init({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'wg-group',
            x_expand: true,
        });

        this._index = index;
        this._model = model;
        this._sidebar = sidebar;
        this._rows = [];
        this._compact = compact;
        this._delegate = this;

        if (compact)
            this._buildCompactHeader();
        else
            this._buildHeader();

        this._rowBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'wg-group-rows',
            x_expand: true,
        });
        this.add_child(this._rowBox);

        if (index === model.activeIndex)
            this.add_style_class_name('wg-group-active');



    }

    get groupIndex() {
        return this._index;
    }

    _buildHeader() {
        const header = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'wg-group-header',
            x_expand: true,
        });
        this.add_child(header);

        // Chrome fills the group header itself with the group colour rather
        // than showing a separate swatch, so the colour is the label.
        const color = this._model.color(this._index);
        const ink = contrastOn(color.hex);
        // The border is always present and merely changes colour, so marking
        // a group active cannot shift the layout. St's box-shadow support is
        // patchy, so a border is the dependable way to draw the ring.
        const ring = this._index === this._model.activeIndex
            ? 'rgba(255,255,255,0.9)' : 'transparent';
        header.style =
            `background-color: ${color.hex}; color: ${ink};` +
            ` border: 2px solid ${ring};`;

        this._nameButton = new St.Button({
            style_class: 'wg-group-name-button',
            x_expand: true,
            can_focus: true,
            x_align: Clutter.ActorAlign.FILL,
            // St.Bin centres a child that does not expand, which centred the
            // group name. Let the label fill instead and the text sits left.
            child: new St.Label({
                text: this._model.name(this._index),
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'wg-group-name',
            }),
        });
        this._nameButton.get_child().clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._nameButton.get_child().style = `color: ${ink};`;
        this._nameButton.connect('clicked',
            () => this._model.workspace(this._index)?.activate(global.get_current_time()));
        this._nameButton.connect('button-press-event', (actor, event) => {
            if (event.get_button() === Clutter.BUTTON_SECONDARY) {
                this._beginRename();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        header.add_child(this._nameButton);

        const arrangement = this._model.arrangement(this._index);
        const nextArrangement = ARRANGEMENTS[
            (ARRANGEMENTS.indexOf(arrangement) + 1) % ARRANGEMENTS.length];
        this._arrangeButton = iconButton(
            ARRANGEMENT_ICON[arrangement],
            `How this group's windows are arranged: ${ARRANGEMENT_LABEL[arrangement]}` +
            ` — click for ${ARRANGEMENT_LABEL[nextArrangement]}`);
        this._colorButton = iconButton('color-select-symbolic',
            `Group colour: ${color.name} — click for the next one`,
            'wg-icon-button');
        this._colorButton.get_child().style = `color: ${ink};`;
        this._colorButton.connect('clicked', () => {
            this._model.cycleColor(this._index);
            this._sidebar.queueRebuild();
        });
        header.add_child(this._colorButton);

        this._arrangeButton.connect('clicked', () => {
            this._model.cycleArrangement(this._index);
            // A fresh layout wants fresh ratios; stale ones belong to the
            // previous arrangement's slot count.
            this._model.setLayoutState(this._index, {});
            this._sidebar.relayout(this._index);
            this._sidebar.queueRebuild();
        });
        this._arrangeButton.get_child().style = `color: ${ink};`;
        header.add_child(this._arrangeButton);

        const remove = iconButton('window-close-symbolic',
            'Delete this group (its windows move to the group above)');
        remove.connect('clicked', () => this._model.removeGroup(this._index));
        remove.reactive = this._model.count > 1;
        remove.get_child().style = `color: ${ink};`;
        header.add_child(remove);

        // Drag the header to reorder groups. The delegate is the section so
        // a drop target receives something it can identify; the header has no
        // handleDragOver of its own, so the target walk passes through it.
        header._delegate = this;
        header.reactive = true;
        this._headerDraggable = DND.makeDraggable(header, {dragActorOpacity: 200});
        this._headerDraggable.connect('drag-begin',
            () => this.add_style_class_name('wg-dragging'));
        this._headerDraggable.connect('drag-end',
            () => this.remove_style_class_name('wg-dragging'));
        this._headerDraggable.connect('drag-cancelled',
            () => this.remove_style_class_name('wg-dragging'));

        this._header = header;
    }

    /** Collapsed groups get only a coloured bar, as in Chrome. Editing the
     *  name, colour or layout means expanding the sidebar again. */
    _buildCompactHeader() {
        const color = this._model.color(this._index);
        const header = new St.Button({
            style_class: 'wg-compact-header',
            can_focus: true,
            track_hover: true,
            x_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                icon_name: 'pan-down-symbolic',
                icon_size: 12,
                style: `color: ${contrastOn(color.hex)};`,
            }),
        });
        header.style = `background-color: ${color.hex};`;
        if (this._index === this._model.activeIndex)
            header.add_style_class_name('wg-compact-header-active');
        header.connect('clicked',
            () => this._model.workspace(this._index)?.activate(global.get_current_time()));
        addTooltip(header, this._model.name(this._index));

        header._delegate = this;
        this._headerDraggable = DND.makeDraggable(header, {dragActorOpacity: 200});
        this._headerDraggable.connect('drag-begin',
            () => this.add_style_class_name('wg-dragging'));
        this._headerDraggable.connect('drag-end',
            () => this.remove_style_class_name('wg-dragging'));
        this._headerDraggable.connect('drag-cancelled',
            () => this.remove_style_class_name('wg-dragging'));

        this.add_child(header);
        this._header = header;
    }

    getDragActor() {
        return new St.Label({
            text: this._model.name(this._index),
            style_class: 'wg-drag-label',
        });
    }

    getDragActorSource() {
        return this._header;
    }

    _beginRename() {
        const entry = new St.Entry({
            style_class: 'wg-rename-entry',
            text: this._model.name(this._index),
            x_expand: true,
        });
        const position = this._header.get_children().indexOf(this._nameButton);
        this._header.remove_child(this._nameButton);
        this._header.insert_child_at_index(entry, position);

        const finish = commit => {
            if (commit)
                this._model.setName(this._index, entry.get_text());
            this._sidebar.queueRebuild();
        };

        entry.clutter_text.connect('activate', () => finish(true));
        entry.clutter_text.connect('key-focus-out', () => finish(false));
        entry.clutter_text.connect('key-press-event', (actor, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                finish(false);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        global.stage.set_key_focus(entry.clutter_text);
        entry.clutter_text.set_selection(0, -1);
    }

    addWindow(win, focused) {
        const row = new WindowRow(win, this._sidebar,
            this._model.color(this._index), this._compact);
        row.setFocused(focused);
        this._rows.push(row);
        this._rowBox.add_child(row);
        return row;
    }

    setDropHighlight(active) {
        if (active)
            this.add_style_class_name('wg-drop-target');
        else
            this.remove_style_class_name('wg-drop-target');
    }

    /* DND drop target — a WindowRow moves that window here; another group's
     * header reorders that group to this position. */
    handleDragOver(source) {
        if (source instanceof WindowRow) {
            this.setDropHighlight(true);
            return DND.DragMotionResult.MOVE_DROP;
        }
        if (source instanceof GroupSection && source !== this) {
            this.setDropHighlight(true);
            return DND.DragMotionResult.MOVE_DROP;
        }
        return DND.DragMotionResult.CONTINUE;
    }

    acceptDrop(source) {
        this.setDropHighlight(false);
        if (source instanceof WindowRow) {
            const from = source.metaWindow.get_workspace()?.index();
            this._model.moveWindowToGroup(source.metaWindow, this._index);
            if (from !== undefined)
                this._sidebar.relayout(from);
            this._sidebar.relayout(this._index);
            return true;
        }
        if (source instanceof GroupSection && source !== this) {
            this._model.moveGroupTo(source.groupIndex, this._index);
            return true;
        }
        return false;
    }
});

/* -------------------------------------------------------------------------
 * Window search
 * ---------------------------------------------------------------------- */

const SearchResult = GObject.registerClass(
class SearchResult extends St.Button {
    _init(entry) {
        super._init({
            style_class: 'wg-search-result',
            x_expand: true,
            can_focus: true,
            track_hover: true,
        });
        this.entry = entry;

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'wg-search-result-box',
            x_expand: true,
        });
        this.set_child(box);

        const app = Shell.WindowTracker.get_default().get_window_app(entry.win);
        box.add_child(app
            ? app.create_icon_texture(24)
            : new St.Icon({icon_name: 'application-x-executable-symbolic', icon_size: 24}));

        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style_class: 'wg-search-result-text',
        });
        const title = new St.Label({
            text: entry.title, style_class: 'wg-search-title',
            x_align: Clutter.ActorAlign.START,
        });
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(title);

        // Chrome's second line is "<group dot> group . site . age"; ours is
        // the group and the application, which is the equivalent context.
        const sub = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'wg-search-sub',
        });
        const dot = new St.Widget({style_class: 'wg-search-dot'});
        dot.style = `background-color: ${entry.color};`;
        sub.add_child(dot);
        const subLabel = new St.Label({
            text: `${entry.group}  ·  ${entry.app}`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        subLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        sub.add_child(subLabel);
        text.add_child(sub);
        box.add_child(text);

        const close = new St.Button({
            style_class: 'wg-search-close',
            child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 14}),
        });
        close.connect('clicked', () => entry.win.delete(global.get_current_time()));
        box.add_child(close);
    }

    setSelected(selected) {
        if (selected)
            this.add_style_class_name('wg-search-selected');
        else
            this.remove_style_class_name('wg-search-selected');
    }
});
class WindowSearch {
    constructor(model, tags) {
        this._model = model;
        this._tags = tags;
        this._grab = null;
        this._results = [];
        this._selected = 0;
    }

    destroy() {
        this.close();
    }

    get isOpen() {
        return this._grab !== null;
    }

    toggle() {
        if (this.isOpen)
            this.close();
        else
            this.open();
    }

    open() {
        if (this.isOpen)
            return;

        this._container = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'wg-search',
            reactive: true,
            can_focus: true,
        });

        this._entry = new St.Entry({
            style_class: 'wg-search-entry',
            hint_text: 'Search windows',
            can_focus: true,
            x_expand: true,
        });
        this._entry.set_primary_icon(
            new St.Icon({icon_name: 'edit-find-symbolic', icon_size: 16}));
        this._container.add_child(this._entry);

        this._container.add_child(new St.Label({
            text: 'Open windows', style_class: 'wg-search-heading',
        }));

        this._scroll = new St.ScrollView({
            style_class: 'wg-search-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            y_expand: true,
        });
        this._list = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL, x_expand: true,
        });
        this._scroll.child = this._list;
        this._container.add_child(this._scroll);

        Main.layoutManager.addTopChrome(this._container);
        this._position();

        this._entry.clutter_text.connect('text-changed', () => this._refresh());
        this._entry.clutter_text.connect('key-press-event',
            (a, event) => this._onKeyPress(event));

        this._grab = Main.pushModal(this._container, {
            actionMode: Shell.ActionMode.NORMAL,
        });
        global.stage.set_key_focus(this._entry.clutter_text);
        this._refresh();
    }

    close() {
        if (!this.isOpen)
            return;
        Main.popModal(this._grab);
        this._grab = null;
        Main.layoutManager.removeChrome(this._container);
        this._container.destroy();
        this._container = null;
        this._results = [];
    }

    _position() {
        const monitor = Main.layoutManager.primaryMonitor;
        const top = Main.layoutManager.panelBox.height;
        const width = Math.min(520, Math.round(monitor.width * 0.4));
        const height = Math.min(640, Math.round(monitor.height * 0.7));
        this._container.set_size(width, height);
        this._container.set_position(
            monitor.x + Math.round((monitor.width - width) / 2),
            monitor.y + top + 40);
    }

    _entries() {
        const out = [];
        for (let g = 0; g < this._model.count; g++) {
            const color = this._model.color(g);
            const group = this._model.name(g);
            for (const win of this._model.windows(g)) {
                const app = Shell.WindowTracker.get_default().get_window_app(win);
                out.push({
                    win,
                    title: win.get_title() ?? '',
                    app: app?.get_name() ?? win.get_wm_class() ?? '',
                    group,
                    color: color.hex,
                });
            }
        }
        return out;
    }

    _refresh() {
        const query = this._entry.get_text();
        this._list.destroy_all_children();
        this._results = [];

        const scored = rankWindows(query, this._entries());

        if (scored.length === 0) {
            this._list.add_child(new St.Label({
                text: 'No windows match', style_class: 'wg-search-empty',
            }));
            return;
        }

        for (const e of scored) {
            const row = new SearchResult(e);
            row.connect('clicked', () => {
                const win = e.win;
                this.close();
                win.activate(global.get_current_time());
            });
            this._list.add_child(row);
            this._results.push(row);
        }
        this._selected = 0;
        this._updateSelection();
    }

    _updateSelection() {
        this._results.forEach((r, i) => r.setSelected(i === this._selected));
    }

    _move(delta) {
        if (this._results.length === 0)
            return;
        this._selected =
            (this._selected + delta + this._results.length) % this._results.length;
        this._updateSelection();
        // Keep the selection in view without stealing focus from the entry.
        const row = this._results[this._selected];
        const adj = this._scroll.vadjustment;
        const y = row.allocation.y1;
        if (y < adj.value)
            adj.value = y;
        else if (y + row.height > adj.value + adj.page_size)
            adj.value = y + row.height - adj.page_size;
    }

    _onKeyPress(event) {
        switch (event.get_key_symbol()) {
        case Clutter.KEY_Escape:
            this.close();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Down:
            this._move(1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Up:
            this._move(-1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter: {
            const row = this._results[this._selected];
            if (row) {
                const win = row.entry.win;
                this.close();
                win.activate(global.get_current_time());
            }
            return Clutter.EVENT_STOP;
        }
        }
        return Clutter.EVENT_PROPAGATE;
    }
}

/* -------------------------------------------------------------------------
 * Sidebar
 * ---------------------------------------------------------------------- */

class Sidebar {
    constructor(model, arranger, settings, tags) {
        this._model = model;
        this._arranger = arranger;
        this._settings = settings;
        this.tags = tags;
        this._sections = [];
        this._rebuildId = 0;
        this._trackedWindows = new Set();

        this.actor = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'wg-sidebar',
            reactive: true,
        });

        this._compact = this._settings.get_boolean('compact');

        // Chrome puts the collapse toggle at the top-left of the strip.
        this._toggle = iconButton('sidebar-show-symbolic',
            this._compact ? 'Expand the sidebar' : 'Shrink the sidebar to icons',
            'wg-icon-button wg-toggle');
        this._toggle.connect('clicked',
            () => this._settings.set_boolean('compact', !this._compact));
        const toggleRow = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'wg-toggle-row',
            x_expand: true,
        });
        toggleRow.add_child(this._toggle);

        this._searchButton = iconButton('edit-find-symbolic',
            'Search windows', 'wg-icon-button wg-toggle');
        this._searchButton.connect('clicked', () => this.search?.toggle());
        toggleRow.add_child(this._searchButton);

        // Auto-hide had no affordance at all and could only be reached
        // through dconf, which is a poor way to discover a headline feature.
        const pinned = !this._settings.get_boolean('auto-hide');
        this._pinButton = iconButton(
            pinned ? 'view-pin-symbolic' : 'sidebar-hide-symbolic',
            pinned
                ? 'Pinned — click to hide the sidebar until you reach for it'
                : 'Auto-hiding — click to keep the sidebar on screen',
            'wg-icon-button wg-toggle');
        if (!pinned)
            this._pinButton.add_style_class_name('wg-toggle-on');
        this._pinButton.connect('clicked',
            () => this._settings.set_boolean('auto-hide', pinned));
        toggleRow.add_child(this._pinButton);

        this.actor.add_child(toggleRow);

        this._scroll = new St.ScrollView({
            style_class: 'wg-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
        });
        this._groupBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'wg-group-box',
            x_expand: true,
        });
        this._scroll.child = this._groupBox;
        this.actor.add_child(this._scroll);

        const newGroup = new St.Button({
            style_class: 'wg-new-group',
            x_expand: true,
            can_focus: true,
            track_hover: true,
            child: new St.Label({text: '+  New group', x_align: Clutter.ActorAlign.CENTER}),
        });
        newGroup.connect('clicked', () => this._model.addGroup());
        this.actor.add_child(newGroup);

        this._autoHide = this._settings.get_boolean('auto-hide');
        this._revealed = !this._autoHide;
        this._hideTimeoutId = 0;
        this._hoverId = 0;
        this._guardId = 0;
        this._edgeDwellId = 0;
        this._hoverExpanded = false;

        // Reserved space and visible width are deliberately different actors.
        // Expanding on hover must draw *over* the windows: if the strut grew
        // with the sidebar, every window on screen would resize each time the
        // pointer brushed the edge. A hidden or compact sidebar reserves only
        // what it occupies when not hovered.
        this._strut = new St.Widget({reactive: false});
        Main.layoutManager.addChrome(this._strut, {
            affectsStruts: true,
            trackFullscreen: true,
        });
        Main.layoutManager.addChrome(this.actor, {
            affectsStruts: false,
            trackFullscreen: true,
        });

        this.actor.connect('enter-event', () => {
            this._cancelHide();
            this._queueHoverExpand(true);
            return Clutter.EVENT_PROPAGATE;
        });
        this.actor.connect('leave-event', () => {
            if (this._autoHide)
                this._queueHide();
            this._queueHoverExpand(false);
            return Clutter.EVENT_PROPAGATE;
        });

        // dragMonitors run before the per-target walk, so this reliably
        // clears stale highlights on every motion event.
        this._dragMonitor = {
            dragMotion: () => {
                for (const section of this._sections)
                    section.setDropHighlight(false);
                return DND.DragMotionResult.CONTINUE;
            },
        };
        DND.addDragMonitor(this._dragMonitor);

        this.updateGeometry();
        this._updateAutoHide();
        this.rebuild();
    }

    /* ---- auto-hide ---------------------------------------------------- */

    _updateAutoHide() {
        this._autoHide = this._settings.get_boolean('auto-hide');
        this._teardownBarrier();

        if (!this._autoHide) {
            this._cancelHide();
            this._revealed = true;
            this.actor.translation_x = 0;
            return;
        }

        this._buildBarrier();
        this._buildEdgeStrip();
        this._hide(true);
    }

    /** A thin reactive strip along the screen edge, revealing after a short
     *  dwell.
     *
     *  The pressure barrier alone is not enough. Pressure accumulates from
     *  *blocked relative motion*, and an absolute pointing device — a tablet,
     *  a touchscreen, anything behind SPICE or VNC — reports a position
     *  rather than a delta, so it can never build any. On those the barrier
     *  silently never fires. The dwell keeps a brush past the edge from
     *  triggering a reveal.
     */
    _buildEdgeStrip() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const top = Main.layoutManager.panelBox.height;

        this._edge = new St.Widget({reactive: true, style_class: 'wg-edge'});
        this._edge.set_position(monitor.x, monitor.y + top);
        this._edge.set_size(2, monitor.height - top);
        Main.layoutManager.addChrome(this._edge, {
            affectsStruts: false,
            trackFullscreen: true,
        });

        this._edge.connect('enter-event', () => {
            if (this._edgeDwellId)
                GLib.source_remove(this._edgeDwellId);
            this._edgeDwellId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, EDGE_DWELL, () => {
                    this._edgeDwellId = 0;
                    if (this._edge?.has_pointer)
                        this._reveal();
                    return GLib.SOURCE_REMOVE;
                });
            return Clutter.EVENT_PROPAGATE;
        });
        this._edge.connect('leave-event', () => {
            if (this._edgeDwellId) {
                GLib.source_remove(this._edgeDwellId);
                this._edgeDwellId = 0;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _teardownEdgeStrip() {
        if (this._edgeDwellId) {
            GLib.source_remove(this._edgeDwellId);
            this._edgeDwellId = 0;
        }
        if (this._edge) {
            Main.layoutManager.removeChrome(this._edge);
            this._edge.destroy();
            this._edge = null;
        }
    }

    _buildBarrier() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const top = Main.layoutManager.panelBox.height;

        // A pressure barrier rather than a plain reactive strip: the same
        // mechanism the hot corner uses, so brushing past the edge while
        // aiming at a window does not fling the sidebar open.
        this._barrier = new Meta.Barrier({
            backend: global.backend,
            x1: monitor.x, x2: monitor.x,
            y1: monitor.y + top, y2: monitor.y + monitor.height,
            // NEGATIVE_X, not POSITIVE_X: the barrier must block motion that
            // would carry the pointer left past the screen edge, which is
            // what accumulates pressure. POSITIVE_X blocks motion out of the
            // edge — something the pointer can never do from x = 0 — so the
            // barrier simply never fired. GNOME's own hot corner uses
            // NEGATIVE_X for exactly this reason.
            directions: Meta.BarrierDirection.NEGATIVE_X,
        });
        this._pressureBarrier = new Layout.PressureBarrier(
            this._settings.get_int('reveal-pressure'),
            REVEAL_TIMEOUT,
            Shell.ActionMode.NORMAL);
        this._pressureBarrier.addBarrier(this._barrier);
        this._pressureBarrier.connect('trigger', () => this._reveal());
    }

    _teardownBarrier() {
        this._teardownEdgeStrip();
        if (this._pressureBarrier) {
            if (this._barrier)
                this._pressureBarrier.removeBarrier(this._barrier);
            this._pressureBarrier.destroy();
            this._pressureBarrier = null;
        }
        if (this._barrier) {
            this._barrier.destroy();
            this._barrier = null;
        }
    }

    _reveal() {
        this._cancelHide();
        if (this._revealed)
            return;
        this._revealed = true;
        this.actor.remove_all_transitions();
        this.actor.ease({
            translation_x: 0,
            duration: SLIDE_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _hide(immediate = false) {
        this._cancelHide();
        this._revealed = false;
        // Include the margin, or a sliver of the panel stays on screen.
        const offscreen =
            -(this.actor.width + this._settings.get_int('sidebar-margin'));
        this.actor.remove_all_transitions();
        if (immediate) {
            this.actor.translation_x = offscreen;
            return;
        }
        this.actor.ease({
            translation_x: offscreen,
            duration: SLIDE_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _queueHide() {
        this._cancelHide();
        this._hideTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, HIDE_DELAY, () => {
                this._hideTimeoutId = 0;
                // Do not slide out from under a pointer that came back.
                if (!this.actor.has_pointer)
                    this._hide();
                return GLib.SOURCE_REMOVE;
            });
    }

    _cancelHide() {
        if (this._hideTimeoutId) {
            GLib.source_remove(this._hideTimeoutId);
            this._hideTimeoutId = 0;
        }
    }

    destroy() {
        if (this._rebuildId) {
            GLib.source_remove(this._rebuildId);
            this._rebuildId = 0;
        }
        this._cancelHide();
        if (this._hoverId) {
            GLib.source_remove(this._hoverId);
            this._hoverId = 0;
        }
        if (this._guardId) {
            GLib.source_remove(this._guardId);
            this._guardId = 0;
        }
        this._teardownBarrier();
        DND.removeDragMonitor(this._dragMonitor);
        for (const win of this._trackedWindows)
            win.disconnectObject(this);
        this._trackedWindows.clear();
        Main.layoutManager.removeChrome(this.actor);
        Main.layoutManager.removeChrome(this._strut);
        this._strut.destroy();
        this._strut = null;
        this.actor.destroy();
        this.actor = null;
    }

    /** Move a window into the group named after its tag, creating that group
     *  if it does not exist yet. Only ever called when a tag is set by hand. */
    applyTag(win) {
        if (!this._settings.get_boolean('auto-group')) {
            this.queueRebuild();
            return;
        }
        if (!isManagedWindow(win))
            return;

        const tag = this.tags.tag(win);
        if (!tag) {
            this.queueRebuild();
            return;
        }

        const index = this._model.ensureGroupNamed(tag, MAX_AUTO_GROUPS);
        if (index === -1) {
            log(`window-groups: not creating a group for "${tag}", ` +
                `already at ${MAX_AUTO_GROUPS} groups`);
            return;
        }

        const from = win.get_workspace()?.index();
        this._model.moveWindowToGroup(win, index);
        if (from !== undefined)
            this.relayout(from);
        this.relayout(index);
        this.queueRebuild();
    }

    /** Compact for rendering purposes. Differs from the setting while the
     *  pointer is expanding the sidebar over the windows. */
    _effectiveCompact() {
        return this._compact && !this._hoverExpanded;
    }

    _queueHoverExpand(wanted) {
        if (!this._compact || !this._settings.get_boolean('expand-on-hover'))
            return;
        if (this._hoverId) {
            GLib.source_remove(this._hoverId);
            this._hoverId = 0;
        }
        if (wanted === this._hoverExpanded)
            return;
        const delay = wanted ? HOVER_EXPAND_DELAY : HOVER_COLLAPSE_DELAY;
        this._hoverId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._hoverId = 0;
            // The pointer may have left again while we waited.
            if (wanted && !this.actor.has_pointer)
                return GLib.SOURCE_REMOVE;
            this._setHoverExpanded(wanted);
            return GLib.SOURCE_REMOVE;
        });
    }

    _setHoverExpanded(expanded) {
        this._hoverExpanded = expanded;
        this.updateGeometry();
        this.rebuild();
        if (expanded)
            this._startHoverGuard();
    }

    /** A leave-event is not guaranteed. The pointer can be warped away, its
     *  device can disappear, or the crossing event can be swallowed by a
     *  grab — and then the sidebar stays expanded over the windows forever.
     *  Poll cheaply while expanded rather than trusting the event. */
    _startHoverGuard() {
        if (this._guardId)
            return;
        this._guardId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT_IDLE, 1, () => {
                if (!this._hoverExpanded || !this.actor) {
                    this._guardId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                if (!this.actor.has_pointer) {
                    this._guardId = 0;
                    this._setHoverExpanded(false);
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            });
    }

    relayout(index) {
        if (index === undefined || index === null || index < 0)
            this._arranger.scheduleAll();
        else
            this._arranger.schedule(index);
    }

    updateGeometry() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const top = Main.layoutManager.panelBox.height;
        const reserved = this._compact
            ? this._settings.get_int('compact-width')
            : this._settings.get_int('sidebar-width');
        const visible = this._effectiveCompact()
            ? this._settings.get_int('compact-width')
            : this._settings.get_int('sidebar-width');
        const margin = Math.max(0, this._settings.get_int('sidebar-margin'));

        // The strut keeps the full reserved width and touches the screen edge:
        // x1 <= monitor.x is what makes layout.js classify it as a
        // Meta.Side.LEFT strut at all, and insetting it would let windows sit
        // under the sidebar rather than beside it.
        this._strut.set_position(monitor.x, monitor.y + top);
        this._strut.set_size(this._autoHide ? 0 : reserved, monitor.height - top);

        // The visible panel floats inside that reservation, so the wallpaper
        // shows through on the left, top and bottom.
        this.actor.set_position(monitor.x + margin, monitor.y + top + margin);
        this.actor.set_size(
            Math.max(1, visible - margin),
            Math.max(1, monitor.height - top - 2 * margin));
        if (this._autoHide && !this._revealed)
            this.actor.translation_x = -(visible + margin);

        if (this._edge) {
            this._edge.set_position(monitor.x, monitor.y + top);
            this._edge.set_size(2, monitor.height - top);
        }
    }

    queueRebuild() {
        if (this._rebuildId)
            return;
        this._rebuildId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._rebuildId = 0;
            this.rebuild();
            return GLib.SOURCE_REMOVE;
        });
    }

    rebuild() {
        this._groupBox.destroy_all_children();
        this._sections = [];

        const focus = global.display.focus_window;

        for (let i = 0; i < this._model.count; i++) {
            const section = new GroupSection(i, this._model, this, this._effectiveCompact());
            this._groupBox.add_child(section);
            this._sections.push(section);

            for (const win of this._model.windows(i)) {
                section.addWindow(win, win === focus);
                this._trackWindow(win);
            }
        }

        // Deliberately not laying out here. rebuild() runs on every title
        // change and focus change; driving geometry from it means every
        // keystroke in a text editor can shove windows around.

    }

    _trackWindow(win) {
        if (this._trackedWindows.has(win))
            return;
        this._trackedWindows.add(win);
        win.connectObject(
            'notify::title', () => this.queueRebuild(),
            'notify::minimized', () => {
                this.relayout(win.get_workspace()?.index());
                this.queueRebuild();
            },
            'notify::fullscreen', () => this.relayout(win.get_workspace()?.index()),
            'workspace-changed', () => {
                this.relayout(win.get_workspace()?.index());
                this.queueRebuild();
            },
            'unmanaged', () => {
                const index = win.get_workspace()?.index();
                this._trackedWindows.delete(win);
                this.tags?.forget(win);
                this._arranger.forget(win);
                this.relayout(index);
                this.queueRebuild();
            },
            this);
    }
}

/* -------------------------------------------------------------------------
 * Debug interface
 * ---------------------------------------------------------------------- */

const DEBUG_IFACE = `
<node>
  <interface name="org.gnome.Shell.Extensions.WindowGroups">
    <method name="GetState">
      <arg type="s" direction="out" name="json"/>
    </method>
    <method name="ActivateGroup">
      <arg type="u" direction="in" name="index"/>
    </method>
    <method name="RemoveGroup">
      <arg type="u" direction="in" name="index"/>
    </method>
    <method name="SetArrangement">
      <arg type="u" direction="in" name="index"/>
      <arg type="s" direction="in" name="arrangement"/>
    </method>
  </interface>
</node>`;

/**
 * A read/drive surface for tests, off unless `debug-interface` is set.
 *
 * Everything before this had to infer state from screenshots, which produced
 * two confidently wrong conclusions: a stale image read as proof a change had
 * not applied, and a pixel scan that counted a dark window as part of the
 * sidebar. Asking the extension what it believes removes that whole class of
 * error.
 */
class DebugInterface {
    constructor(model, sidebar, tags) {
        this._model = model;
        this._sidebar = sidebar;
        this._tags = tags;
        this._impl = Gio.DBusExportedObject.wrapJSObject(DEBUG_IFACE, this);
        this._impl.export(Gio.DBus.session,
            '/org/gnome/Shell/Extensions/WindowGroups');
    }

    destroy() {
        this._impl?.unexport();
        this._impl = null;
    }

    GetState() {
        const groups = [];
        for (let i = 0; i < this._model.count; i++) {
            groups.push({
                index: i,
                name: this._model.name(i),
                color: this._model.color(i).name,
                arrangement: this._model.arrangement(i),
                active: i === this._model.activeIndex,
                windows: this._model.windows(i).map(win => ({
                    title: win.get_title() ?? '',
                    wmClass: win.get_wm_class() ?? '',
                    monitor: win.get_monitor(),
                    tag: this._tags?.tag(win) ?? '',
                    frame: (({x, y, width, height}) =>
                        ({x, y, width, height}))(win.get_frame_rect()),
                })),
            });
        }
        return JSON.stringify({
            groups,
            activeGroup: this._model.activeIndex,
            sidebar: {
                width: this._sidebar?.actor?.width ?? 0,
                compact: this._sidebar?._effectiveCompact?.() ?? false,
                autoHide: this._sidebar?._autoHide ?? false,
                revealed: this._sidebar?._revealed ?? true,
                edgeStrip: !!this._sidebar?._edge,
                // The flag is set before the animation runs; report the actual
                // actor geometry too, or a test can pass while nothing moved.
                translationX: this._sidebar?.actor?.translation_x ?? 0,
                x: this._sidebar?.actor?.x ?? 0,
                onScreen: (this._sidebar?.actor?.x ?? 0) +
                    (this._sidebar?.actor?.translation_x ?? 0) +
                    (this._sidebar?.actor?.width ?? 0) > 0,
                hoverExpanded: this._sidebar?._hoverExpanded ?? false,
            },
        });
    }

    ActivateGroup(index) {
        this._model.workspace(index)?.activate(global.get_current_time());
    }

    RemoveGroup(index) {
        this._model.removeGroup(index);
    }

    SetArrangement(index, arrangement) {
        if (!ARRANGEMENTS.includes(arrangement))
            throw new Error(`unknown arrangement: ${arrangement}`);
        this._model.setArrangement(index, arrangement);
    }
}

/* -------------------------------------------------------------------------
 * Extension
 * ---------------------------------------------------------------------- */

export default class WindowGroupsExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._mutterSettings = new Gio.Settings({schema_id: 'org.gnome.mutter'});

        // Groups only have stable identity if GNOME stops creating and
        // destroying workspaces underneath us.
        this._hadDynamicWorkspaces = this._mutterSettings.get_boolean('dynamic-workspaces');
        if (this._hadDynamicWorkspaces)
            this._mutterSettings.set_boolean('dynamic-workspaces', false);

        this._model = new GroupModel(this._settings);
        this._arranger = new Arranger({
            model: this._model,
            env: {
                getWorkAreaForMonitor: m =>
                    Main.layoutManager.getWorkAreaForMonitor(m),
                getFocusWindow: () => global.display.focus_window,
                isManaged: isManagedWindow,
                defer: fn => GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    fn();
                    return GLib.SOURCE_REMOVE;
                }),
                cancel: handle => GLib.source_remove(handle),
                maximizeFlags: Meta.MaximizeFlags.HORIZONTAL |
                    Meta.MaximizeFlags.VERTICAL,
            },
        });
        this._tags = new TagStore();
        this._search = new WindowSearch(this._model, this._tags);
        this._sidebar = new Sidebar(
            this._model, this._arranger, this._settings, this._tags);
        this._sidebar.search = this._search;

        Main.wm.addKeybinding('search-windows', this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._search.toggle());

        global.display.connectObject(
            'window-created', (display, win) => {
                if (!isManagedWindow(win))
                    return;
                // Placing before first-frame is pointless: the client sets its
                // own geometry as it maps and overwrites whatever we did.
                const actor = win.get_compositor_private();
                if (actor) {
                    const id = actor.connect('first-frame', () => {
                        actor.disconnect(id);
                        this._sidebar?.relayout(win.get_workspace()?.index());
                    });
                }
                this._sidebar.queueRebuild();
            },
            'notify::focus-window', () => this._sidebar.queueRebuild(),
            'grab-op-end', (display, win, op) => {
                if (!win)
                    return;
                if (RESIZE_GRAB_OPS.has(op)) {
                    // Absorb the drag into the layout instead of snapping the
                    // window back on the next pass.
                    this._arranger.absorbResize(win);
                    return;
                }
                if (op === Meta.GrabOp.MOVING_UNCONSTRAINED ||
                    op === Meta.GrabOp.KEYBOARD_MOVING) {
                    // A tiled window that was dragged has to go back into its
                    // slot; the layout, not the pointer, owns its position.
                    this._sidebar.relayout(win.get_workspace()?.index());
                    this._sidebar.queueRebuild();
                }
            },
            this);

        global.workspace_manager.connectObject(
            'workspace-added', () => this._sidebar.queueRebuild(),
            'workspace-removed', () => this._sidebar.queueRebuild(),
            'workspaces-reordered', () => this._sidebar.queueRebuild(),
            'workspace-switched', (mgr, from, to) => {
                this._sidebar.relayout(to);
                this._sidebar.queueRebuild();
            },
            this);

        // Struts change the usable rectangle without any window moving, so a
        // layout computed against the old work area would be stale.
        global.display.connectObject(
            'workareas-changed', () => this._sidebar.relayout(),
            this);

        // Renaming from the sidebar calls queueRebuild() itself, but the name
        // also lives in a shared GNOME key that Settings (or the user) can
        // change from outside.
        this._model.wmPrefs.connectObject(
            'changed::workspace-names', () => this._sidebar.queueRebuild(),
            this);

        Main.layoutManager.connectObject(
            'monitors-changed', () => {
                this._sidebar.updateGeometry();
                this._sidebar.relayout();
                this._sidebar.queueRebuild();
            },
            this);

        if (this._settings.get_boolean('debug-interface')) {
            this._debug = new DebugInterface(
                this._model, this._sidebar, this._tags);
        }

        this._settings.connectObject(
            'changed::sidebar-width', () => this._sidebar.updateGeometry(),
            // Width, row contents and header shape all differ, and the strut
            // follows the actor's allocation, so a full rebuild is simplest.
            'changed::compact', () => this._reloadSidebar(),
            'changed::compact-width', () => this._sidebar.updateGeometry(),
            'changed::sidebar-margin', () => this._sidebar.updateGeometry(),
            'changed::debug-interface', () => {
                this._debug?.destroy();
                this._debug = this._settings.get_boolean('debug-interface')
                    ? new DebugInterface(this._model, this._sidebar, this._tags)
                    : null;
            },
            'changed::expand-on-hover', () => this._reloadSidebar(),
            // The header buttons call queueRebuild() themselves, but a write
            // from outside (gsettings, a prefs dialog, a second monitor of
            // the same key) would otherwise not be picked up until some
            // unrelated event happened to trigger a rebuild.
            'changed::arrangements', () => {
                this._sidebar.relayout();
                this._sidebar.queueRebuild();
            },
            'changed::gap', () => this._sidebar.relayout(),
            'changed::outer-gap', () => this._sidebar.relayout(),
            'changed::layout-states', () => this._sidebar.relayout(),
            'changed::colors', () => this._sidebar.queueRebuild(),
            'changed::auto-group', () => this._sidebar.queueRebuild(),
            // Struts are fixed at addChrome() time, so flipping auto-hide
            // has to re-register the actor, not just move it.
            'changed::auto-hide', () => this._reloadSidebar(),
            'changed::reveal-pressure', () => this._reloadSidebar(),
            this);
    }

    _reloadSidebar() {
        this._sidebar?.destroy();
        this._sidebar = new Sidebar(
            this._model, this._arranger, this._settings, this._tags);
        this._sidebar.search = this._search;
        if (this._debug)
            this._debug._sidebar = this._sidebar;
    }

    disable() {
        this._debug?.destroy();
        this._debug = null;
        Main.wm.removeKeybinding('search-windows');
        this._search?.destroy();
        this._search = null;
        global.display.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._model?.wmPrefs?.disconnectObject(this);
        this._settings?.disconnectObject(this);

        this._sidebar?.destroy();
        this._sidebar = null;
        this._model?.destroy();
        this._model = null;
        this._arranger?.destroy();
        this._arranger = null;
        this._tags?.destroy();
        this._tags = null;

        if (this._hadDynamicWorkspaces)
            this._mutterSettings?.set_boolean('dynamic-workspaces', true);
        this._mutterSettings = null;
        this._settings = null;
    }
}
