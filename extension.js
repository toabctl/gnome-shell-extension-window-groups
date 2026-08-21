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
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const ICON_SIZE = 18;
const BUTTON_ICON_SIZE = 14;

/** Arrangements a group can use. Deliberately only two for now: the
 *  sidebar UX is what needs validating, and real tiling is a separate
 *  (much larger) problem best delegated to an existing tiling extension. */
const ARRANGEMENTS = ['free', 'tabbed'];

const ARRANGEMENT_ICON = {
    free: 'view-grid-symbolic',
    tabbed: 'view-paged-symbolic',
};

const ARRANGEMENT_LABEL = {
    free: 'Free',
    tabbed: 'Tabbed',
};

/** Group colours, modelled on Chrome's tab groups. 'none' comes first so
 *  cycling always has a way back to an unstyled group. */
const GROUP_COLORS = [
    {name: 'none',   hex: null},
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
        const values = this._padded(this._settings.get_strv('colors'), 'none');
        values[index] = name;
        this._settings.set_strv('colors', values);
    }

    cycleColor(index) {
        const current = GROUP_COLORS.indexOf(this.color(index));
        const next = GROUP_COLORS[(current + 1) % GROUP_COLORS.length];
        this.setColor(index, next.name);
        return next;
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
        const wanted = name.trim().toLowerCase();
        for (let i = 0; i < this.count; i++) {
            if (this.name(i).trim().toLowerCase() === wanted)
                return i;
        }
        return -1;
    }

    /** Return the index of the group called `name`, creating it if needed.
     *  Returns -1 if the cap would be exceeded. */
    ensureGroupNamed(name, cap) {
        const existing = this.indexOfName(name);
        if (existing !== -1)
            return existing;

        // Reuse an unnamed, empty group before appending. Static workspaces
        // GNOME created up front would otherwise linger as empty clutter
        // above every auto-created group.
        for (let i = 0; i < this.count; i++) {
            if (this.rawName(i) === '' && this.windows(i).length === 0) {
                this.setName(i, name);
                return i;
            }
        }

        if (this.count >= cap)
            return -1;
        this.addGroup();
        const index = this.count - 1;
        this.setName(index, name);
        return index;
    }

    addGroup() {
        global.workspace_manager.append_new_workspace(false, global.get_current_time());
    }

    /** Remove a group, rehoming its windows into the group above it. */
    removeGroup(index) {
        if (this.count <= 1)
            return;
        const target = index === 0 ? 1 : index - 1;
        for (const win of this.windows(index))
            win.change_workspace_by_index(target, false);

        this._spliceParallel(index);
        global.workspace_manager.remove_workspace(
            this.workspace(index), global.get_current_time());
    }

    moveGroup(index, delta) {
        const to = index + delta;
        if (to < 0 || to >= this.count)
            return;
        // reorder_workspace() moves the workspace but does not know about
        // names or arrangements, so we keep both parallel arrays in step.
        this._swapParallel(index, to);
        global.workspace_manager.reorder_workspace(this.workspace(index), to);
    }

    moveWindowToGroup(win, index) {
        if (win.get_workspace()?.index() !== index)
            win.change_workspace_by_index(index, false);
    }

    _padded(values, fill) {
        const out = values.slice();
        while (out.length < this.count)
            out.push(fill);
        return out;
    }

    _swapParallel(a, b) {
        const swap = (getter, setter, fill) => {
            const values = this._padded(getter(), fill);
            [values[a], values[b]] = [values[b], values[a]];
            setter(values);
        };
        swap(() => this._wmPrefs.get_strv('workspace-names'),
            v => this._wmPrefs.set_strv('workspace-names', v), '');
        swap(() => this._settings.get_strv('arrangements'),
            v => this._settings.set_strv('arrangements', v), 'free');
        swap(() => this._settings.get_strv('colors'),
            v => this._settings.set_strv('colors', v), 'none');
    }

    _spliceParallel(index) {
        const splice = (getter, setter, fill) => {
            const values = this._padded(getter(), fill);
            values.splice(index, 1);
            setter(values);
        };
        splice(() => this._wmPrefs.get_strv('workspace-names'),
            v => this._wmPrefs.set_strv('workspace-names', v), '');
        splice(() => this._settings.get_strv('arrangements'),
            v => this._settings.set_strv('arrangements', v), 'free');
        splice(() => this._settings.get_strv('colors'),
            v => this._settings.set_strv('colors', v), 'none');
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

class Arranger {
    constructor(model) {
        this._model = model;
    }

    applyAll() {
        for (let i = 0; i < this._model.count; i++)
            this.apply(i);
    }

    apply(index) {
        if (this._model.arrangement(index) !== 'tabbed')
            return;

        // "Tabbed" is the same illusion browsers use: every window in the
        // group gets identical geometry and the focused one is on top.
        // Nothing is hidden, so there is nothing to get out of sync.
        for (const win of this._model.windows(index)) {
            if (win.minimized || win.fullscreen || !win.allows_resize())
                continue;
            const area = Main.layoutManager.getWorkAreaForMonitor(win.get_monitor());
            if (!area)
                continue;
            const frame = win.get_frame_rect();
            if (frame.x === area.x && frame.y === area.y &&
                frame.width === area.width && frame.height === area.height)
                continue;
            win.move_resize_frame(false, area.x, area.y, area.width, area.height);
        }

        const focus = global.display.focus_window;
        if (focus && focus.get_workspace()?.index() === index)
            focus.raise();
    }
}

/* -------------------------------------------------------------------------
 * Widgets
 * ---------------------------------------------------------------------- */

function iconButton(iconName, accessibleName, styleClass = 'wg-icon-button') {
    return new St.Button({
        style_class: styleClass,
        can_focus: true,
        accessible_name: accessibleName,
        child: new St.Icon({icon_name: iconName, icon_size: BUTTON_ICON_SIZE}),
    });
}

const WindowRow = GObject.registerClass(
class WindowRow extends St.Button {
    _init(win, sidebar) {
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
        });
        this.set_child(box);

        const app = Shell.WindowTracker.get_default().get_window_app(win);
        box.add_child(app
            ? app.create_icon_texture(ICON_SIZE)
            : new St.Icon({icon_name: 'application-x-executable-symbolic', icon_size: ICON_SIZE}));

        this._label = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            style_class: 'wg-window-title',
        });
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(this._label);
        this.updateTitle();

        this._box = box;
        const tag = sidebar?.tags?.tag(win);
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
    _init(index, model, sidebar) {
        super._init({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'wg-group',
            x_expand: true,
        });

        this._index = index;
        this._model = model;
        this._sidebar = sidebar;
        this._rows = [];
        this._delegate = this;

        this._buildHeader();

        this._rowBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'wg-group-rows',
            x_expand: true,
        });
        this.add_child(this._rowBox);

        if (index === model.activeIndex)
            this.add_style_class_name('wg-group-active');

        const color = model.color(index);
        if (color.hex) {
            this.style = `border-left: 3px solid ${color.hex};`;
            this._nameButton.get_child().style = `color: ${color.hex};`;
        }

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

        const color = this._model.color(this._index);
        this._colorDot = new St.Button({
            style_class: 'wg-color-dot',
            can_focus: true,
            accessible_name: `Group colour: ${color.name} (click to change)`,
            child: new St.Widget({style_class: 'wg-color-dot-swatch'}),
        });
        this._colorDot.get_child().style = color.hex
            ? `background-color: ${color.hex};`
            : 'background-color: transparent; border: 1px solid rgba(255,255,255,0.45);';
        this._colorDot.connect('clicked', () => {
            this._model.cycleColor(this._index);
            this._sidebar.queueRebuild();
        });
        header.add_child(this._colorDot);

        this._nameButton = new St.Button({
            style_class: 'wg-group-name-button',
            x_expand: true,
            can_focus: true,
            child: new St.Label({
                text: this._model.name(this._index),
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'wg-group-name',
            }),
        });
        this._nameButton.get_child().clutter_text.ellipsize = Pango.EllipsizeMode.END;
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
        this._arrangeButton = iconButton(
            ARRANGEMENT_ICON[arrangement],
            `Arrangement: ${ARRANGEMENT_LABEL[arrangement]} (click to change)`);
        this._arrangeButton.connect('clicked', () => {
            this._model.cycleArrangement(this._index);
            this._sidebar.queueRebuild();
        });
        header.add_child(this._arrangeButton);

        const up = iconButton('go-up-symbolic', 'Move group up');
        up.connect('clicked', () => this._model.moveGroup(this._index, -1));
        up.reactive = this._index > 0;
        header.add_child(up);

        const down = iconButton('go-down-symbolic', 'Move group down');
        down.connect('clicked', () => this._model.moveGroup(this._index, 1));
        down.reactive = this._index < this._model.count - 1;
        header.add_child(down);

        const remove = iconButton('window-close-symbolic', 'Remove group');
        remove.connect('clicked', () => this._model.removeGroup(this._index));
        remove.reactive = this._model.count > 1;
        header.add_child(remove);

        this._header = header;
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
        const row = new WindowRow(win, this._sidebar);
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

    /* DND drop target — accepts a WindowRow dragged from any group. */
    handleDragOver(source) {
        if (!(source instanceof WindowRow))
            return DND.DragMotionResult.CONTINUE;
        this.setDropHighlight(true);
        return DND.DragMotionResult.MOVE_DROP;
    }

    acceptDrop(source) {
        this.setDropHighlight(false);
        if (!(source instanceof WindowRow))
            return false;
        this._model.moveWindowToGroup(source.metaWindow, this._index);
        return true;
    }
});

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
            child: new St.Label({text: '+  New group', x_align: Clutter.ActorAlign.CENTER}),
        });
        newGroup.connect('clicked', () => this._model.addGroup());
        this.actor.add_child(newGroup);

        Main.layoutManager.addChrome(this.actor, {
            affectsStruts: true,
            trackFullscreen: true,
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
        this.rebuild();
    }

    destroy() {
        if (this._rebuildId) {
            GLib.source_remove(this._rebuildId);
            this._rebuildId = 0;
        }
        DND.removeDragMonitor(this._dragMonitor);
        for (const win of this._trackedWindows)
            win.disconnectObject(this);
        this._trackedWindows.clear();
        Main.layoutManager.removeChrome(this.actor);
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

        this._model.moveWindowToGroup(win, index);
        this.queueRebuild();
    }

    updateGeometry() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const top = Main.layoutManager.panelBox.height;
        const width = this._settings.get_int('sidebar-width');
        // x1 <= monitor.x is what makes layout.js classify this as a
        // Meta.Side.LEFT strut, so the work area shrinks for real.
        this.actor.set_position(monitor.x, monitor.y + top);
        this.actor.set_size(width, monitor.height - top);
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
            const section = new GroupSection(i, this._model, this);
            this._groupBox.add_child(section);
            this._sections.push(section);

            for (const win of this._model.windows(i)) {
                section.addWindow(win, win === focus);
                this._trackWindow(win);
            }
        }

        this._arranger.applyAll();
    }

    _trackWindow(win) {
        if (this._trackedWindows.has(win))
            return;
        this._trackedWindows.add(win);
        win.connectObject(
            'notify::title', () => this.queueRebuild(),
            'notify::minimized', () => this.queueRebuild(),
            'workspace-changed', () => this.queueRebuild(),
            'unmanaged', () => {
                this._trackedWindows.delete(win);
                this.tags?.forget(win);
                this.queueRebuild();
            },
            this);
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
        this._arranger = new Arranger(this._model);
        this._tags = new TagStore();
        this._sidebar = new Sidebar(
            this._model, this._arranger, this._settings, this._tags);

        global.display.connectObject(
            'window-created', (display, win) => {
                if (isManagedWindow(win))
                    this._sidebar.queueRebuild();
            },
            'notify::focus-window', () => this._sidebar.queueRebuild(),
            'grab-op-end', (display, win, op) => {
                if (op === Meta.GrabOp.MOVING || op === Meta.GrabOp.KEYBOARD_MOVING)
                    this._sidebar.queueRebuild();
            },
            this);

        global.workspace_manager.connectObject(
            'workspace-added', () => this._sidebar.queueRebuild(),
            'workspace-removed', () => this._sidebar.queueRebuild(),
            'workspaces-reordered', () => this._sidebar.queueRebuild(),
            'workspace-switched', () => this._sidebar.queueRebuild(),
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
                this._sidebar.queueRebuild();
            },
            this);

        this._settings.connectObject(
            'changed::sidebar-width', () => this._sidebar.updateGeometry(),
            // The header buttons call queueRebuild() themselves, but a write
            // from outside (gsettings, a prefs dialog, a second monitor of
            // the same key) would otherwise not be picked up until some
            // unrelated event happened to trigger a rebuild.
            'changed::arrangements', () => this._sidebar.queueRebuild(),
            'changed::colors', () => this._sidebar.queueRebuild(),
            'changed::auto-group', () => this._sidebar.queueRebuild(),
            this);
    }

    disable() {
        global.display.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._model?.wmPrefs?.disconnectObject(this);
        this._settings?.disconnectObject(this);

        this._sidebar?.destroy();
        this._sidebar = null;
        this._model?.destroy();
        this._model = null;
        this._arranger = null;
        this._tags?.destroy();
        this._tags = null;

        if (this._hadDynamicWorkspaces)
            this._mutterSettings?.set_boolean('dynamic-workspaces', true);
        this._mutterSettings = null;
        this._settings = null;
    }
}
