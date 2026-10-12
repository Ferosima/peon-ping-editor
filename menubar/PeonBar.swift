// PeonBar — macOS menu-bar switch for peon-ping: sounds on/off, volume, default pack.
// All changes go through peon.sh so peon-ping's adapters stay in sync.

import AppKit

let home = FileManager.default.homeDirectoryForCurrentUser.path
// The installer records where peon-ping lives; launchd gives GUI apps no shell environment to read it from
let peonDir = UserDefaults.standard.string(forKey: "peonDir")
    ?? ProcessInfo.processInfo.environment["PEON_DIR"]
    ?? "\(home)/.claude/hooks/peon-ping"
let peonScript = "\(peonDir)/peon.sh"
let configPath = "\(peonDir)/config.json"
let pausedPath = "\(peonDir)/.paused"
let editorURL = URL(string: "http://127.0.0.1:8787/")!

// Written by install.sh; used to check for and install updates
let defaults = UserDefaults.standard
let safeSlug = { (v: String?, fallback: String) -> String in
    guard let v = v, v.range(of: "^[A-Za-z0-9._/-]+$", options: .regularExpression) != nil else { return fallback }
    return v
}
let updateRepo = safeSlug(defaults.string(forKey: "repo"), "Ferosima/peon-ping-editor")
let updateRef = safeSlug(defaults.string(forKey: "ref"), "main")
let editorHome = defaults.string(forKey: "editorHome") ?? "\(home)/.peon-editor"

func installedVersion() -> String {
    let pkg = readJSON("\(editorHome)/app/package.json")
    return pkg["version"] as? String
        ?? Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
        ?? "0.0.0"
}

// Plain numeric compare of x.y.z; anything after a "-" is ignored
func isNewer(_ a: String, than b: String) -> Bool {
    let parts = { (v: String) -> [Int] in
        v.split(separator: "-").first.map { $0.split(separator: ".").map { Int($0) ?? 0 } } ?? []
    }
    let x = parts(a), y = parts(b)
    for i in 0..<max(x.count, y.count) {
        let l = i < x.count ? x[i] : 0, r = i < y.count ? y[i] : 0
        if l != r { return l > r }
    }
    return false
}

func readConfig() -> [String: Any] {
    guard let data = FileManager.default.contents(atPath: configPath),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
    return obj
}

func readJSON(_ path: String) -> [String: Any] {
    guard let data = FileManager.default.contents(atPath: path),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
    return obj
}

@discardableResult
func runPeon(_ args: [String]) -> Bool {
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/bin/bash")
    proc.arguments = [peonScript] + args
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:\(home)/.local/bin"
    proc.environment = env
    proc.standardOutput = FileHandle.nullDevice
    proc.standardError = FileHandle.nullDevice
    do {
        try proc.run()
        proc.waitUntilExit()
        return proc.terminationStatus == 0
    } catch {
        return false
    }
}

struct Pack {
    let name: String
    let displayName: String
}

func installedPacks() -> [Pack] {
    let dir = "\(peonDir)/packs"
    let names = (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []
    return names.sorted().compactMap { name in
        let manifest = readJSON("\(dir)/\(name)/openpeon.json")
        guard !manifest.isEmpty || FileManager.default.fileExists(atPath: "\(dir)/\(name)/manifest.json") else { return nil }
        return Pack(name: name, displayName: manifest["display_name"] as? String ?? name)
    }
}

// A short line from the default pack, played after the volume changes
func sampleSound(pack: String) -> String? {
    let dir = "\(peonDir)/packs/\(pack)"
    let cats = readJSON("\(dir)/openpeon.json")["categories"] as? [String: Any] ?? [:]
    for cat in ["task.complete", "session.start", "task.acknowledge"] {
        let sounds = (cats[cat] as? [String: Any])?["sounds"] as? [[String: Any]] ?? []
        for sound in sounds {
            guard let file = sound["file"] as? String else { continue }
            for candidate in ["\(dir)/\(file)", "\(dir)/sounds/\((file as NSString).lastPathComponent)"]
            where FileManager.default.fileExists(atPath: candidate) {
                return candidate
            }
        }
    }
    return nil
}

// Stops the sound peon-ping is playing (it records the player's pid), but only if that pid is still a player:
// pids get reused, and killing an unrelated process would be bad
func stopCurrentSound() {
    guard let text = try? String(contentsOfFile: "\(peonDir)/.sound.pid", encoding: .utf8),
          let pid = Int32(text.trimmingCharacters(in: .whitespacesAndNewlines)), pid > 1 else { return }
    let ps = Process()
    ps.executableURL = URL(fileURLWithPath: "/bin/ps")
    ps.arguments = ["-o", "comm=", "-p", String(pid)]
    let pipe = Pipe()
    ps.standardOutput = pipe
    ps.standardError = FileHandle.nullDevice
    guard (try? ps.run()) != nil else { return }
    ps.waitUntilExit()
    let command = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    let name = (command.trimmingCharacters(in: .whitespacesAndNewlines) as NSString).lastPathComponent
    guard ["afplay", "peon-play"].contains(name) else { return }
    kill(pid, SIGTERM)
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let menu = NSMenu()
    let slider = NSSlider(value: 50, minValue: 0, maxValue: 100, target: nil, action: nil)
    let volumeLabel = NSTextField(labelWithString: "")
    var preview: NSSound?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // One menu-bar icon only: login item, installer and a manual launch can all start PeonBar
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "com.peonping.peonbar")
            .filter { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
        if !others.isEmpty {
            NSApp.terminate(nil)
            return
        }
        menu.delegate = self
        item.menu = menu
        slider.target = self
        slider.action = #selector(volumeChanged(_:))
        slider.isContinuous = true
        refreshIcon()
        Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.refreshIcon() }
        announceFinishedUpdate()
        listenForBannerClose()
        // Look for a new version shortly after login, then every few hours (at most once a day)
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in self?.autoCheck() }
        Timer.scheduledTimer(withTimeInterval: 6 * 3600, repeats: true) { [weak self] _ in self?.autoCheck() }
    }

    var paused: Bool { FileManager.default.fileExists(atPath: pausedPath) }

    // peon-ping's own icon from the local install (this repo ships no game art); speaker symbols if it is missing
    lazy var peonIcon: NSImage? = NSImage(contentsOfFile: "\(peonDir)/docs/peon-icon.png")
    lazy var iconOn: NSImage? = statusImage(muted: false)
    lazy var iconMuted: NSImage? = statusImage(muted: true)

    func statusImage(muted: Bool) -> NSImage? {
        guard let base = peonIcon else { return nil }
        let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { rect in
            NSBezierPath(roundedRect: rect, xRadius: 4, yRadius: 4).addClip()
            base.draw(in: rect, from: .zero, operation: .sourceOver, fraction: muted ? 0.35 : 1)
            if muted {
                let slash = NSBezierPath()
                slash.move(to: NSPoint(x: 2, y: 2))
                slash.line(to: NSPoint(x: rect.maxX - 2, y: rect.maxY - 2))
                slash.lineWidth = 2.4
                slash.lineCapStyle = .round
                NSColor.systemRed.setStroke()
                slash.stroke()
            }
            return true
        }
        image.isTemplate = false
        return image
    }

    func refreshIcon() {
        var image = paused ? iconMuted : iconOn
        if image == nil {
            image = NSImage(systemSymbolName: paused ? "speaker.slash.fill" : "speaker.wave.2.fill", accessibilityDescription: nil)
            image?.isTemplate = true
        }
        image?.accessibilityDescription = paused ? "peon-ping muted" : "peon-ping on"
        item.button?.image = image
        item.button?.toolTip = paused ? "peon-ping: muted" : "peon-ping: sounds on"
    }

    // Rebuilt every time the menu opens, so it always shows the current config
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let cfg = readConfig()
        let defaultPack = cfg["default_pack"] as? String ?? cfg["active_pack"] as? String ?? "peon"
        let packs = installedPacks()
        let packTitle = packs.first { $0.name == defaultPack }?.displayName ?? defaultPack

        let header = NSMenuItem(title: "peon-ping · \(packTitle)", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        menu.addItem(.separator())

        let toggle = NSMenuItem(title: "Sounds on", action: #selector(toggleSounds), keyEquivalent: "")
        toggle.target = self
        toggle.state = paused ? .off : .on
        menu.addItem(toggle)

        let volume = (cfg["volume"] as? Double) ?? 0.5
        slider.doubleValue = volume * 100
        volumeLabel.stringValue = "Volume \(Int((volume * 100).rounded()))%"
        menu.addItem(volumeItem())

        menu.addItem(.separator())
        let packsItem = NSMenuItem(title: "Default pack", action: nil, keyEquivalent: "")
        let packsMenu = NSMenu()
        for pack in packs {
            let entry = NSMenuItem(title: pack.displayName, action: #selector(usePack(_:)), keyEquivalent: "")
            entry.target = self
            entry.representedObject = pack.name
            entry.state = pack.name == defaultPack ? .on : .off
            packsMenu.addItem(entry)
        }
        packsItem.submenu = packsMenu
        menu.addItem(packsItem)

        let editor = NSMenuItem(title: "Open pack editor…", action: #selector(openEditor), keyEquivalent: "")
        editor.target = self
        menu.addItem(editor)

        let update: NSMenuItem
        if updating {
            update = NSMenuItem(title: "Updating…", action: nil, keyEquivalent: "")
            update.isEnabled = false
        } else if let latest = availableVersion {
            update = NSMenuItem(title: "Update to \(latest)…", action: #selector(checkForUpdates), keyEquivalent: "")
        } else {
            update = NSMenuItem(title: "Check for Updates…", action: #selector(checkForUpdates), keyEquivalent: "")
        }
        update.target = self
        menu.addItem(update)

        let login = NSMenuItem(title: "Start at login", action: #selector(toggleLogin), keyEquivalent: "")
        login.target = self
        login.state = FileManager.default.fileExists(atPath: agentPath) ? .on : .off
        menu.addItem(login)

        menu.addItem(.separator())
        let version = NSMenuItem(title: "peon-ping editor \(installedVersion())", action: nil, keyEquivalent: "")
        version.isEnabled = false
        menu.addItem(version)
        let quit = NSMenuItem(title: "Quit PeonBar", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quit)
    }

    func volumeItem() -> NSMenuItem {
        let view = NSView(frame: NSRect(x: 0, y: 0, width: 240, height: 48))
        volumeLabel.frame = NSRect(x: 20, y: 26, width: 200, height: 16)
        volumeLabel.font = .menuFont(ofSize: 12)
        volumeLabel.textColor = .secondaryLabelColor
        slider.frame = NSRect(x: 18, y: 4, width: 204, height: 22)
        view.addSubview(volumeLabel)
        view.addSubview(slider)
        let entry = NSMenuItem()
        entry.view = view
        return entry
    }

    // Same LaunchAgent the installer writes; RunAtLoad starts PeonBar on every login
    let agentPath = "\(home)/Library/LaunchAgents/com.peonping.peonbar.plist"

    @objc func toggleLogin() {
        if FileManager.default.fileExists(atPath: agentPath) {
            try? FileManager.default.removeItem(atPath: agentPath)
            return
        }
        // Same shape as install.sh writes, so Login Items shows "PeonBar"
        let plist: [String: Any] = [
            "Label": "com.peonping.peonbar",
            "ProgramArguments": [Bundle.main.executablePath ?? "\(Bundle.main.bundlePath)/Contents/MacOS/PeonBar"],
            "AssociatedBundleIdentifiers": [Bundle.main.bundleIdentifier ?? "com.peonping.peonbar"],
            "RunAtLoad": true,
            "ProcessType": "Interactive",
            "AbandonProcessGroup": true,
        ]
        try? FileManager.default.createDirectory(atPath: (agentPath as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        (plist as NSDictionary).write(toFile: agentPath, atomically: true)
    }

    // peon.sh runs python, which takes a moment: never on the main thread, or the menu bar stutters
    func runInBackground(_ args: [String], then done: (() -> Void)? = nil) {
        DispatchQueue.global(qos: .userInitiated).async {
            runPeon(args)
            DispatchQueue.main.async { done?() }
        }
    }

    @objc func toggleSounds() {
        runInBackground([paused ? "resume" : "pause"]) { [weak self] in self?.refreshIcon() }
    }

    var pendingVolume: DispatchWorkItem?

    @objc func volumeChanged(_ sender: NSSlider) {
        let percent = Int(sender.doubleValue.rounded())
        volumeLabel.stringValue = "Volume \(percent)%"
        // Save once the slider settles (mouse or keyboard), not on every step
        pendingVolume?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.runInBackground(["volume", String(format: "%.2f", Double(percent) / 100)]) {
                self?.playSample(volume: Float(percent) / 100)
            }
        }
        pendingVolume = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35, execute: work)
    }

    func playSample(volume: Float) {
        let cfg = readConfig()
        let pack = cfg["default_pack"] as? String ?? cfg["active_pack"] as? String ?? "peon"
        guard volume > 0, let path = sampleSound(pack: pack), let sound = NSSound(contentsOfFile: path, byReference: true) else { return }
        preview?.stop()
        sound.volume = volume
        sound.play()
        preview = sound
    }

    @objc func usePack(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String else { return }
        runInBackground(["packs", "use", name])
    }

    // The installer writes this launcher; it finds node (Homebrew, nvm, volta, …) on its own
    var launcher: String {
        UserDefaults.standard.string(forKey: "editorLauncher") ?? "\(home)/.local/bin/peon-editor"
    }

    @objc func openEditor() {
        var request = URLRequest(url: editorURL.appendingPathComponent("api/packs"))
        request.timeoutInterval = 1
        URLSession.shared.dataTask(with: request) { [launcher] _, response, _ in
            let running = (response as? HTTPURLResponse)?.statusCode == 200
            if !running {
                guard FileManager.default.isExecutableFile(atPath: launcher) else {
                    DispatchQueue.main.async { Self.alert("peon-editor is not installed", "Expected it at \(launcher). Run the installer again.") }
                    return
                }
                let proc = Process()
                proc.executableURL = URL(fileURLWithPath: launcher)
                proc.arguments = ["--no-open"]
                proc.standardOutput = FileHandle.nullDevice
                proc.standardError = FileHandle.nullDevice
                try? proc.run()
                // Wait for the server instead of guessing how long node takes to start
                var up = false
                for _ in 0..<40 {
                    Thread.sleep(forTimeInterval: 0.25)
                    if (try? Data(contentsOf: editorURL.appendingPathComponent("api/packs"))) != nil { up = true; break }
                    if !proc.isRunning { break }
                }
                if !up {
                    DispatchQueue.main.async {
                        Self.alert("The editor did not start",
                                   "Port 8787 may be taken by another app, or peon-ping/Node is missing. Run peon-editor in Terminal to see the error.")
                    }
                    return
                }
            }
            DispatchQueue.main.async { NSWorkspace.shared.open(editorURL) }
        }.resume()
    }

    // MARK: - Stop the sound when a banner is closed

    // peon-ping's banners post "com.peonping.dismiss[.<theme>].<slot>" when clicked or closed — not when they
    // time out — so the sound still playing belongs to the banner the user just dismissed.
    func listenForBannerClose() {
        let center = DistributedNotificationCenter.default()
        for prefix in ["com.peonping.dismiss.", "com.peonping.dismiss.glass.", "com.peonping.dismiss.sakura.", "com.peonping.dismiss.jarvis."] {
            for slot in 0..<10 {
                center.addObserver(self, selector: #selector(bannerClosed), name: Notification.Name(prefix + String(slot)), object: nil)
            }
        }
    }

    @objc func bannerClosed() {
        guard (readConfig()["x_editor_stop_sound_on_close"] as? Bool) ?? true else { return }
        DispatchQueue.global(qos: .userInitiated).async { stopCurrentSound() }
    }

    // MARK: - Updates

    var availableVersion: String?
    var updating = false

    func fetchLatestVersion(_ done: @escaping (Result<String, Error>) -> Void) {
        // The query string skips GitHub's raw-file cache so a fresh push is seen right away
        let url = URL(string: "https://raw.githubusercontent.com/\(updateRepo)/\(updateRef)/package.json?t=\(Int(Date().timeIntervalSince1970))")!
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        request.setValue("PeonBar", forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: request) { data, response, error in
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard error == nil, code == 200, let data = data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let version = obj["version"] as? String else {
                let reason = error?.localizedDescription ?? "GitHub answered \(code)"
                DispatchQueue.main.async { done(.failure(NSError(domain: "PeonBar", code: code, userInfo: [NSLocalizedDescriptionKey: reason]))) }
                return
            }
            DispatchQueue.main.async { done(.success(version)) }
        }.resume()
    }

    func autoCheck() {
        let last = defaults.double(forKey: "lastUpdateCheck")
        guard Date().timeIntervalSince1970 - last > 24 * 3600 else { return }
        fetchLatestVersion { [weak self] result in
            guard case .success(let latest) = result else { return }
            defaults.set(Date().timeIntervalSince1970, forKey: "lastUpdateCheck")
            self?.availableVersion = isNewer(latest, than: installedVersion()) ? latest : nil
        }
    }

    @objc func checkForUpdates() {
        fetchLatestVersion { [weak self] result in
            guard let self = self else { return }
            let current = installedVersion()
            switch result {
            case .failure(let error):
                Self.alert("Could not check for updates", error.localizedDescription)
            case .success(let latest):
                defaults.set(Date().timeIntervalSince1970, forKey: "lastUpdateCheck")
                guard isNewer(latest, than: current) else {
                    self.availableVersion = nil
                    Self.alert("You're up to date", "peon-ping editor \(current) is the latest version.")
                    return
                }
                self.availableVersion = latest
                let alert = NSAlert()
                alert.messageText = "peon-ping editor \(latest) is available"
                alert.informativeText = "You have \(current). Updating takes under a minute; PeonBar restarts when it is done."
                alert.addButton(withTitle: "Update")
                alert.addButton(withTitle: "Later")
                NSApp.activate(ignoringOtherApps: true)
                if alert.runModal() == .alertFirstButtonReturn { self.runUpdate(to: latest) }
            }
        }
    }

    // Runs the same one-line installer people use. It replaces and restarts PeonBar, which ends this process,
    // so the installer runs in its own process group (set -m) and survives that.
    func runUpdate(to version: String) {
        updating = true
        defaults.set(version, forKey: "pendingUpdate")
        let log = "\(editorHome)/update.log"
        try? FileManager.default.createDirectory(atPath: editorHome, withIntermediateDirectories: true)
        let script = "set -m; (curl -fsSL 'https://raw.githubusercontent.com/\(updateRepo)/\(updateRef)/install.sh' | PEON_EDITOR_REF='\(updateRef)' PEON_EDITOR_REPO='\(updateRepo)' bash) >'\(log)' 2>&1 & wait $!"
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/bash")
        proc.arguments = ["-c", script]
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "\(home)/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        proc.environment = env
        proc.terminationHandler = { [weak self] p in
            // Only reached if this PeonBar was not replaced: the update failed, or the menu-bar part was skipped
            DispatchQueue.main.async {
                self?.updating = false
                defaults.removeObject(forKey: "pendingUpdate")
                if p.terminationStatus == 0 {
                    self?.availableVersion = nil
                    Self.alert("Updated to \(installedVersion())", "Reopen the editor to use the new version.")
                } else {
                    Self.alert("The update failed", "Details are in \(log). You can also run the install command from the README in Terminal.")
                }
            }
        }
        do {
            try proc.run()
        } catch {
            updating = false
            Self.alert("The update failed", error.localizedDescription)
        }
    }

    // The new PeonBar, started by the installer, confirms the update the old one began
    func announceFinishedUpdate() {
        guard let pending = defaults.string(forKey: "pendingUpdate") else { return }
        defaults.removeObject(forKey: "pendingUpdate")
        let now = installedVersion()
        guard !isNewer(pending, than: now) else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            Self.alert("peon-ping editor updated to \(now)", "Sounds, packs and settings are unchanged.")
        }
    }

    static func alert(_ title: String, _ text: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = text
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
