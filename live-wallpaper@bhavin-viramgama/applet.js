const Applet = imports.ui.applet;
const Settings = imports.ui.settings;
const PopupMenu = imports.ui.popupMenu;
const Util = imports.misc.util;
const GLib = imports.gi.GLib;
const Main = imports.ui.main;
const Gio = imports.gi.Gio;
const St = imports.gi.St;
const Mainloop = imports.mainloop;

class LiveWallpaperApplet extends Applet.IconApplet {
    constructor(metadata, orientation, panel_height, instance_id) {
        super(orientation, panel_height, instance_id);

        this.uuid = metadata.uuid;
        this.set_applet_icon_name("video-display");
        this.set_applet_tooltip("Live Wallpaper Controls");

        this.settings = new Settings.AppletSettings(this, this.uuid, instance_id);
        this.settings.bind("wallpaper-mode", "wallpaper_mode", this.on_settings_changed);
        this.settings.bind("custom-playlist", "custom_playlist", this.on_settings_changed);
        this.settings.bind("video-file", "video_file", this.on_settings_changed);
        this.settings.bind("video-folder", "video_folder", this.on_settings_changed);
        this.settings.bind("custom-path", "custom_path", this.on_settings_changed);
        this.settings.bind("mute-all", "mute_all", this.on_settings_changed);
        this.settings.bind("hide-icon", "hide_icon", this.on_settings_changed);
        this.settings.bind("smart-pause", "smart_pause", this.on_settings_changed);
        this.settings.bind("autostart", "autostart");
        this.settings.bind("target-display", "target_display", this.on_settings_changed);

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);

        this._initContextMenu();
        this.isPlaying = false;
        this.isMuted = true;
        this.isSmartPaused = false;
        this.smartPauseLoopId = 0;

        this._checkDependencies();
    }

    on_applet_added_to_panel() {
        if (this.hide_icon) {
            this.actor.hide();
        }
        if (this.autostart) {
            this.startWallpaper();
        }
    }

    _checkDependencies() {
        let missing = [];
        if (!GLib.find_program_in_path("mpv")) missing.push("mpv");
        if (!GLib.find_program_in_path("xwinwrap")) missing.push("xwinwrap");
        if (!GLib.find_program_in_path("socat")) missing.push("socat");

        if (missing.length > 0) {
            let msg = `Missing dependencies: ${missing.join(', ')}. Please run the install-deps.sh script inside ~/.local/share/cinnamon/applets/${this.uuid}`;
            Main.notify("Live Wallpaper Applet", msg);
            this.set_applet_tooltip(msg);
        }
    }

    _initContextMenu() {
        this.togglePlayItem = new PopupMenu.PopupMenuItem("Start Wallpaper");
        this.togglePlayItem.connect('activate', () => this.togglePlayback());
        this.menu.addMenuItem(this.togglePlayItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this.prevTrackItem = new PopupMenu.PopupIconMenuItem("Previous", "media-skip-backward-symbolic", St.IconType.SYMBOLIC);
        this.prevTrackItem.connect('activate', () => this.sendCommand(["playlist-prev"]));
        this.menu.addMenuItem(this.prevTrackItem);

        this.nextTrackItem = new PopupMenu.PopupIconMenuItem("Next", "media-skip-forward-symbolic", St.IconType.SYMBOLIC);
        this.nextTrackItem.connect('activate', () => this.sendCommand(["playlist-next"]));
        this.menu.addMenuItem(this.nextTrackItem);

        this.audioSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this.audioSeparator);

        // Mute Toggle
        this.muteItem = new PopupMenu.PopupIconMenuItem("Unmute", "audio-volume-muted-symbolic", St.IconType.SYMBOLIC);
        this.muteItem.connect('activate', () => this.toggleMute());
        this.menu.addMenuItem(this.muteItem);

        // Volume Slider
        this.volumeLabel = new PopupMenu.PopupMenuItem("Volume:", { reactive: false });
        this.menu.addMenuItem(this.volumeLabel);

        this.volumeSlider = new PopupMenu.PopupSliderMenuItem(0.0);
        this.volumeSlider.connect('value-changed', (slider, value) => {
            let volume = Math.round(value * 100);
            this.sendCommand(["set_property", "volume", volume]);
            if (this.isMuted && volume > 0) {
                this.toggleMute();
            }
        });
        this.menu.addMenuItem(this.volumeSlider);
    }

    toggleMute() {
        this.isMuted = !this.isMuted;
        let iconName = this.isMuted ? "audio-volume-muted-symbolic" : "audio-volume-high-symbolic";
        let label = this.isMuted ? "Unmute" : "Mute";

        this.muteItem.label.set_text(label);
        this.muteItem.setIconSymbolicName(iconName);

        let property = this.isMuted ? "yes" : "no";
        this.sendCommand(["set_property", "mute", property]);
    }

    on_applet_clicked(event) {
        this.menu.toggle();
    }

    _decodePath(path) {
        if (!path) return null;
        path = path.trim();
        if (path.startsWith("file://")) {
            path = path.substring(7);
        }
        try {
            return decodeURIComponent(path);
        } catch (e) {
            return path;
        }
    }

    getWallpaperPath() {
        if (this.wallpaper_mode === "playlist") {
            if (this.custom_playlist && this.custom_playlist.length > 0) {
                let m3uPath = GLib.get_user_config_dir() + "/live-wallpaper-playlist.m3u";
                let m3uContent = "";
                for (let item of this.custom_playlist) {
                    if (item.file) {
                        m3uContent += this._decodePath(item.file) + "\n";
                    }
                }
                if (m3uContent !== "") {
                    let file = Gio.File.new_for_path(m3uPath);
                    file.replace_contents(m3uContent, null, false, Gio.FileCreateFlags.NONE, null);
                    return m3uPath;
                }
            }
            return null;
        }

        if (this.wallpaper_mode === "custom") {
            return this._decodePath(this.custom_path);
        }

        if (this.wallpaper_mode === "folder") {
            return this._decodePath(this.video_folder);
        }

        if (this.wallpaper_mode === "single") {
            return this._decodePath(this.video_file);
        }

        return null;
    }

    getLaunchCommand() {
        let path = this.getWallpaperPath();
        if (!path) return null;

        let displayArg = "-fs";

        // Multi-monitor support: fetch geometry if specific display is chosen
        if (this.target_display !== -1) {
            let monitors = Main.layoutManager.monitors;
            if (this.target_display < monitors.length) {
                let m = monitors[this.target_display];
                displayArg = `-g ${m.width}x${m.height}+${m.x}+${m.y}`;
            }
        }

        let audioArg = this.mute_all ? "--ao=null" : "--mute=yes";
        return `xwinwrap ${displayArg} -fdt -ni -b -nf -- mpv -wid WID --loop-playlist=inf --no-osc --no-osd-bar --panscan=1.0 ${audioArg} --input-ipc-server=/tmp/mpv-wallpaper-socket "${path}"`;
    }

    on_settings_changed() {
        if (this.hide_icon) {
            this.actor.hide();
        } else {
            this.actor.show();
        }

        if (this.isPlaying) {
            this.stopWallpaper();
            this.startWallpaper();
        }
    }

    startWallpaper() {
        let cmd = this.getLaunchCommand();
        if (!cmd) {
            Main.notify("Live Wallpaper", "Please configure a video file, folder, or custom playlist in the applet settings.");
            return;
        }

        let execCmd = `bash -c "while ! pgrep -x nemo-desktop > /dev/null; do sleep 0.5; done; ${cmd.replace(/"/g, '\\"')}"`;

        Util.spawnCommandLine(execCmd);
        this.isPlaying = true;
        this.togglePlayItem.label.set_text("Stop Wallpaper");

        let isSingle = (this.wallpaper_mode === "single" || this.wallpaper_mode === "custom");
        this.nextTrackItem.setSensitive(!isSingle);
        this.prevTrackItem.setSensitive(!isSingle);

        this.isMuted = true;
        this.muteItem.label.set_text("Unmute");
        this.muteItem.setIconSymbolicName("audio-volume-muted-symbolic");
        this.volumeSlider.setValue(0.0);

        if (this.mute_all) {
            this.audioSeparator.actor.hide();
            this.muteItem.actor.hide();
            this.volumeLabel.actor.hide();
            this.volumeSlider.actor.hide();
        } else {
            this.audioSeparator.actor.show();
            this.muteItem.actor.show();
            this.volumeLabel.actor.show();
            this.volumeSlider.actor.show();
        }

        // Start smart pause loop if enabled
        if (this.smart_pause && this.smartPauseLoopId === 0) {
            this.smartPauseLoopId = Mainloop.timeout_add_seconds(1, () => this._onSmartPauseTick());
        }
    }

    stopWallpaper() {
        // Stop smart pause loop
        if (this.smartPauseLoopId > 0) {
            Mainloop.source_remove(this.smartPauseLoopId);
            this.smartPauseLoopId = 0;
        }

        Util.spawnCommandLine("pkill -f 'mpv.*mpv-wallpaper-socket'");
        Util.spawnCommandLine("pkill -f 'xwinwrap.*mpv-wallpaper-socket'");
        this.isPlaying = false;
        this.isSmartPaused = false;
        this.togglePlayItem.label.set_text("Start Wallpaper");
    }

    togglePlayback() {
        if (this.isPlaying) {
            this.stopWallpaper();
        } else {
            this.startWallpaper();
        }
    }

    sendCommand(cmdArray) {
        if (!this.isPlaying) return;

        // Properly convert the command array to JSON and escape it for the shell
        // e.g. {"command":["playlist-next"]} becomes {\\"command\\":[\\"playlist-next\\"]}
        let jsonStr = JSON.stringify({ command: cmdArray });
        let escapedJsonStr = jsonStr.replace(/"/g, '\\"');

        Util.spawnCommandLine(`sh -c "echo '${escapedJsonStr}' | socat - /tmp/mpv-wallpaper-socket"`);
    }

    _onSmartPauseTick() {
        if (!this.isPlaying) {
            this.smartPauseLoopId = 0;
            return false;
        }

        let shouldPause = false;
        let actors = global.get_window_actors();

        for (let actor of actors) {
            let win = actor.get_meta_window();
            if (!win) continue;

            // Check if window is on the target monitor
            let monitorIndex = win.get_monitor();
            let isTargetMonitor = (this.target_display === -1) || (monitorIndex === this.target_display);

            if (isTargetMonitor) {
                // Check if window is maximized or fullscreen, and not hidden/minimized
                if ((win.get_maximized() !== 0 || win.is_fullscreen()) && !win.is_hidden() && !win.minimized) {
                    shouldPause = true;
                    break;
                }
            }
        }

        if (shouldPause !== this.isSmartPaused) {
            this.isSmartPaused = shouldPause;
            this.sendCommand(["set_property", "pause", shouldPause]);
        }

        return true; // Keep the loop running
    }
}

function main(metadata, orientation, panel_height, instance_id) {
    return new LiveWallpaperApplet(metadata, orientation, panel_height, instance_id);
}
