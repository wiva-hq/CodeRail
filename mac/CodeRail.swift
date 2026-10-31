// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// CodeRail for Mac: a menu bar app that puts this Mac on a CodeRail site without the terminal.
//
// The bridge ships inside the app as an app of its own (Contents/Helpers/CodeRail Bridge.app: macOS grants
// Local Network access only to a bundled program that says why). On launch the app copies it to
// ~/.coderail/CodeRail Bridge.app when the version changed, so the bridge's launchd service runs from a path
// that doesn't move with the app, and a new app brings a new bridge; ~/.coderail/bin/coderail links to it. Linking runs
// `coderail link <site> --json` and shows the code while the user approves it in the browser. The menu
// shows the bridge's state from ~/.coderail/state.json; quitting the app leaves the bridge running.
// Sparkle updates the app from dl.coderail.codes (SUFeedURL in Info.plist); the updated app then brings
// its bridge in the same way.
import AppKit
import ServiceManagement
import Sparkle
import SwiftUI

let home = FileManager.default.homeDirectoryForCurrentUser
let stateDir = home.appendingPathComponent(".coderail")
/// The bridge as installed, and its program; ~/.coderail/bin/coderail links there for the terminal.
let bridgeApp = stateDir.appendingPathComponent("CodeRail Bridge.app")
let binPath = bridgeApp.appendingPathComponent("Contents/MacOS/coderail")
let linkPath = stateDir.appendingPathComponent("bin/coderail")
let configPath = stateDir.appendingPathComponent("config.json")
let statePath = stateDir.appendingPathComponent("state.json")
let accessPath = stateDir.appendingPathComponent("access.json")
let logPath = stateDir.appendingPathComponent("bridge.log")
let serviceLabel = "codes.coderail.bridge"

struct LinkConfig: Decodable {
  let server: String
  let machineId: String
  let name: String
}

struct BridgeState: Decodable {
  let state: String
  let pid: Int?
}

/// `coderail access`'s answer: whether the bridge has Full Disk Access (null when it can't tell).
struct AccessState: Decodable {
  let fullDiskAccess: Bool?
}

/// The bridge as this app sees it: linked or not, and the running service's connection state.
enum Status: Equatable {
  case notLinked
  case paused
  case connecting
  case connected
  case offline
  case removed

  var title: String {
    switch self {
    case .notLinked: return "Not linked"
    case .paused: return "Paused"
    case .connecting: return "Connecting…"
    case .connected: return "Connected"
    case .offline: return "Offline, retrying"
    case .removed: return "Removed from the site"
    }
  }
}

func readJSON<T: Decodable>(_ url: URL, as: T.Type) -> T? {
  guard let data = try? Data(contentsOf: url) else { return nil }
  return try? JSONDecoder().decode(T.self, from: data)
}

@discardableResult
func run(_ path: String, _ args: [String], env: [String: String] = [:]) -> (code: Int32, out: String) {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: path)
  p.arguments = args
  p.environment = ProcessInfo.processInfo.environment.merging(env) { $1 }
  let pipe = Pipe()
  p.standardOutput = pipe
  p.standardError = pipe
  do { try p.run() } catch { return (-1, error.localizedDescription) }
  let data = pipe.fileHandleForReading.readDataToEndOfFile()
  p.waitUntilExit()
  return (p.terminationStatus, String(data: data, encoding: .utf8) ?? "")
}

func serviceLoaded() -> Bool {
  run("/bin/launchctl", ["print", "gui/\(getuid())/\(serviceLabel)"]).code == 0
}

func currentStatus() -> Status {
  guard FileManager.default.fileExists(atPath: configPath.path) else { return .notLinked }
  let state = readJSON(statePath, as: BridgeState.self)
  if state?.state == "removed" { return .removed }
  guard serviceLoaded() else { return .paused }
  switch state?.state {
  case "connected": return .connected
  case "offline": return .offline
  default: return .connecting
  }
}

/// The site this copy of the app was downloaded from, from the download's quarantine record.
func downloadedFromSite() -> String? {
  let url = Bundle.main.bundleURL
  guard let values = try? url.resourceValues(forKeys: [.quarantinePropertiesKey]),
    let props = values.quarantineProperties
  else { return nil }
  for key in [kLSQuarantineDataURLKey as String, kLSQuarantineOriginURLKey as String] {
    if let s = props[key] as? String ?? (props[key] as? URL)?.absoluteString,
      let u = URL(string: s), let scheme = u.scheme, scheme.hasPrefix("http"), let host = u.host
    {
      return "\(scheme)://\(host)\(u.port.map { ":\($0)" } ?? "")"
    }
  }
  return nil
}

func normalizeSite(_ s: String) -> String? {
  var t = s.trimmingCharacters(in: .whitespacesAndNewlines)
  if t.isEmpty { return nil }
  if !t.hasPrefix("http://") && !t.hasPrefix("https://") { t = "https://" + t }
  while t.hasSuffix("/") { t.removeLast() }
  guard let u = URL(string: t), let host = u.host else { return nil }
  // The machine token goes to this site: only over https, except a server on this computer.
  if u.scheme != "https" && !["localhost", "127.0.0.1", "::1"].contains(host) { return nil }
  return t
}

enum InstallError: LocalizedError {
  case message(String)
  var errorDescription: String? {
    if case .message(let m) = self { return m }
    return nil
  }
}

let accessJob = "codes.coderail.access"
let bundledApp = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/CodeRail Bridge.app")
let bundledBin = bundledApp.appendingPathComponent("Contents/MacOS/coderail")

func bridgeVersion(_ url: URL) -> String? {
  guard FileManager.default.isExecutableFile(atPath: url.path) else { return nil }
  let r = run(url.path, ["version"])
  return r.code == 0 ? r.out.trimmingCharacters(in: .whitespacesAndNewlines) : nil
}

/// Puts the app's bridge at ~/.coderail/CodeRail Bridge.app if it's missing or a different version (with
/// ~/.coderail/bin/coderail linking to it), and restarts the service if it was running. Returns true when it
/// installed a new copy.
private let syncLock = NSLock()

@discardableResult
func syncBridge() throws -> Bool {
  // (Called from several places at launch; two copies at once would race on coderail.new.)
  syncLock.lock()
  defer { syncLock.unlock() }
  guard let bundled = bridgeVersion(bundledBin) else {
    throw InstallError.message("This copy of CodeRail is damaged (the bridge inside it doesn't run). Download it again.")
  }
  let fm = FileManager.default
  let linked = (try? fm.destinationOfSymbolicLink(atPath: linkPath.path)) == binPath.path
  if bridgeVersion(binPath) == bundled && linked { return false }
  try fm.createDirectory(at: stateDir, withIntermediateDirectories: true)
  if bridgeVersion(binPath) != bundled {
    let tmp = stateDir.appendingPathComponent("CodeRail Bridge.new.app")
    try? fm.removeItem(at: tmp)
    guard run("/usr/bin/ditto", [bundledApp.path, tmp.path]).code == 0 else {
      throw InstallError.message("CodeRail couldn't copy its bridge to \(stateDir.path).")
    }
    run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", tmp.path])
    if fm.fileExists(atPath: bridgeApp.path) {
      _ = try fm.replaceItemAt(bridgeApp, withItemAt: tmp)
    } else {
      try fm.moveItem(at: tmp, to: bridgeApp)
    }
  }
  // (The terminal's `coderail`, and what older versions ran: a link to the bridge in its bundle.)
  try fm.createDirectory(at: linkPath.deletingLastPathComponent(), withIntermediateDirectories: true)
  try? fm.removeItem(at: linkPath)
  try fm.createSymbolicLink(at: linkPath, withDestinationURL: binPath)
  // (The service runs whatever path it was installed with: install it again, so it runs the bundled one.)
  if FileManager.default.fileExists(atPath: configPath.path) && serviceLoaded() {
    run(binPath.path, ["service", "install"])
  }
  return true
}

// MARK: - Linking window

/// Splits a process's output into lines; only touched from the pipe's one reader queue.
final class LineReader: @unchecked Sendable {
  private var buffer = Data()

  func feed(_ chunk: Data) -> [Data] {
    buffer.append(chunk)
    var lines: [Data] = []
    while let nl = buffer.firstIndex(of: 0x0A) {
      lines.append(Data(buffer[buffer.startIndex..<nl]))
      buffer.removeSubrange(buffer.startIndex...nl)
    }
    return lines
  }
}

@MainActor
final class LinkModel: ObservableObject {
  enum Phase: Equatable {
    case enterSite
    case working(String)
    case approve(code: String, url: String)
    case done(name: String)
    case failed(String)
  }

  @Published var site: String
  @Published var phase: Phase = .enterSite
  /// Whether the bridge has Full Disk Access, from `coderail access` run under launchd (so the answer is the
  /// bridge's own, as its service will run). The site can't be entered until it's true.
  @Published var fullDisk: Bool?
  @Published var settingsOpened = false
  private var accessTimer: Timer?
  var onLinked: () -> Void = {}
  private var process: Process?

  init(site: String) {
    self.site = site
    Task.detached {
      try? syncBridge()
      run("/bin/launchctl", ["remove", accessJob])
      // (An answer left from an earlier run may be stale: Full Disk Access can be taken away.)
      try? FileManager.default.removeItem(at: accessPath)
      run("/bin/launchctl", ["submit", "-l", accessJob, "--", binPath.path, "access", "--wait", "1800"])
    }
    accessTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.checkAccess() }
    }
  }

  private func checkAccess() {
    fullDisk = readJSON(accessPath, as: AccessState.self)?.fullDiskAccess ?? fullDisk
    if fullDisk == true { stopAccessCheck() }
  }

  func stopAccessCheck() {
    accessTimer?.invalidate()
    accessTimer = nil
    run("/bin/launchctl", ["remove", accessJob])
  }

  /// System Settings at Privacy & Security › Full Disk Access, and the bridge selected in Finder to drag in.
  func openFullDiskSettings() {
    for s in ["x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles",
              "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"] {
      if let u = URL(string: s), NSWorkspace.shared.open(u) { break }
    }
    NSWorkspace.shared.activateFileViewerSelecting([bridgeApp])
    settingsOpened = true
  }

  func start() {
    guard let s = normalizeSite(site) else {
      phase = .failed("Enter your CodeRail site's address, like https://coderail.example.com")
      return
    }
    site = s
    phase = .working("Setting up CodeRail…")
    Task.detached {
      do {
        try syncBridge()
        await MainActor.run { self.link(s) }
      } catch {
        await MainActor.run { self.phase = .failed(error.localizedDescription) }
      }
    }
  }

  private func link(_ site: String) {
    phase = .working("Asking \(URL(string: site)?.host ?? site) for a code…")
    let p = Process()
    p.executableURL = binPath
    p.arguments = ["link", site, "--json"]
    p.environment = ProcessInfo.processInfo.environment.merging(["CODERAIL_NO_OPEN": "1"]) { $1 }
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = pipe
    let lines = LineReader()
    pipe.fileHandleForReading.readabilityHandler = { [weak self] h in
      let chunk = h.availableData
      if chunk.isEmpty {
        h.readabilityHandler = nil
        return
      }
      for line in lines.feed(chunk) {
        guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
        nonisolated(unsafe) let event = obj
        Task { @MainActor in self?.handle(event) }
      }
    }
    p.terminationHandler = { [weak self] proc in
      Task { @MainActor in
        guard let self else { return }
        if case .done = self.phase { return }
        if case .failed = self.phase { return }
        if proc.terminationReason == .uncaughtSignal { return }
        self.phase = .failed("Linking stopped before it finished. Try again.")
      }
    }
    do {
      try p.run()
      process = p
    } catch {
      phase = .failed(error.localizedDescription)
    }
  }

  private func handle(_ e: [String: Any]) {
    switch e["event"] as? String {
    case "code":
      let code = e["code"] as? String ?? ""
      // The page to approve on: only on the site being linked to.
      var url = site
      if let u = e["url"] as? String, let a = URL(string: u), let b = URL(string: site), a.scheme == b.scheme, a.host == b.host, a.port == b.port { url = u }
      phase = .approve(code: code, url: url)
      if let u = URL(string: url) { NSWorkspace.shared.open(u) }
    case "linked":
      phase = .done(name: e["name"] as? String ?? Host.current().localizedName ?? "this Mac")
      onLinked()
    case "error":
      phase = .failed(e["message"] as? String ?? "Linking failed.")
    default:
      break
    }
  }

  func cancel() {
    process?.terminate()
    process = nil
    stopAccessCheck()
  }
}

struct LinkView: View {
  @ObservedObject var model: LinkModel
  var close: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack(spacing: 12) {
        Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 48, height: 48)
        VStack(alignment: .leading, spacing: 2) {
          Text("Connect this Mac to CodeRail").font(.title2.weight(.semibold))
          Text("Use Claude Code and Codex on this Mac from anywhere.")
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      Divider()
      content
      HStack { Spacer(); BuiltByWiva(); Spacer() }.padding(.top, 4)
    }
    .padding(24)
    .frame(width: 480)
  }

  @ViewBuilder var content: some View {
    switch model.phase {
    case .enterSite where model.fullDisk != true:
      VStack(alignment: .leading, spacing: 10) {
        HStack {
          Text("Allow Full Disk Access").font(.headline)
          Spacer()
          if model.fullDisk == false {
            Label("Not allowed yet", systemImage: "exclamationmark.circle.fill").foregroundStyle(.orange)
          } else {
            ProgressView().controlSize(.small)
          }
        }
        Text("So CodeRail can open any folder on this Mac.")
          .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        if model.settingsOpened {
          Text("In System Settings, click **+** under Full Disk Access (or drag **CodeRail Bridge** from the Finder window that opened into the list), then turn it on.")
            .font(.callout).fixedSize(horizontal: false, vertical: true)
        }
      }
      HStack {
        Spacer()
        Button("Cancel", action: close).keyboardShortcut(.cancelAction)
        Button(model.settingsOpened ? "Open Settings Again" : "Open Settings") { model.openFullDiskSettings() }
          .keyboardShortcut(.defaultAction)
      }
    case .enterSite, .failed:
      VStack(alignment: .leading, spacing: 8) {
        Text("Your CodeRail site").font(.headline)
        TextField("https://coderail.example.com", text: $model.site)
          .textFieldStyle(.roundedBorder)
          .onSubmit { model.start() }
        if case .failed(let msg) = model.phase {
          Text(msg).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
        }
      }
      HStack {
        Spacer()
        Button("Cancel", action: close).keyboardShortcut(.cancelAction)
        Button("Connect") { model.start() }.keyboardShortcut(.defaultAction)
      }
    case .working(let text):
      HStack(spacing: 10) {
        ProgressView().controlSize(.small)
        Text(text)
      }
      HStack {
        Spacer()
        Button("Cancel") {
          model.cancel()
          close()
        }
      }
    case .approve(let code, let url):
      VStack(alignment: .leading, spacing: 10) {
        Text("Approve this Mac in your browser").font(.headline)
        Text("In the browser, check the code matches and approve.")
          .fixedSize(horizontal: false, vertical: true)
        Text(code)
          .font(.system(size: 28, weight: .semibold, design: .monospaced))
          .padding(.vertical, 6)
          .textSelection(.enabled)
        HStack(spacing: 8) {
          ProgressView().controlSize(.small)
          Text("Waiting for approval…").foregroundStyle(.secondary)
        }
      }
      HStack {
        Button("Open the page again") {
          if let u = URL(string: url) { NSWorkspace.shared.open(u) }
        }
        Spacer()
        Button("Cancel") {
          model.cancel()
          close()
        }
      }
    case .done(let name):
      VStack(alignment: .leading, spacing: 8) {
        Label("Linked as \"\(name)\"", systemImage: "checkmark.circle.fill")
          .font(.headline)
          .foregroundStyle(.green)
        Text(
          "CodeRail now runs in the background and starts when you log in. It's in the menu bar if you need it."
        )
        .fixedSize(horizontal: false, vertical: true)
      }
      HStack {
        Spacer()
        Button("Open CodeRail") {
          if let u = URL(string: model.site) { NSWorkspace.shared.open(u) }
          close()
        }
        .keyboardShortcut(.defaultAction)

      }
    }
  }
}

// MARK: - Built by Wiva

/// Wiva's mark (design/brand/wiva-mark.svg): four soft forms around a center, drawn from its path, which uses
/// only absolute moves and cubic curves on a 100-unit square.
struct WivaMark: Shape {
  static let d = "M34.43 0.08C34.4 0.13, 34.06 0.2, 33.67 0.24C21.47 1.39, 13.49 14.54, 16.65 28.27C18.79 37.53, 26.55 47.64, 33.84 50.65C37.06 51.99, 38.23 49.64, 35.84 46.63C33.42 43.58, 32.27 41.63, 31.46 39.18C30.13 35.19, 30.41 29.94, 32.06 28.16C32.88 27.26, 33.65 27.15, 35.79 27.64C41.81 29.01, 48.89 24.77, 50.97 18.57C53.73 10.32, 47.07 1.05, 37.8 0.24C37.37 0.2, 36.98 0.13, 36.95 0.08C36.89 -0.03, 34.5 -0.03, 34.43 0.08M75.54 14.81C67.21 15.65, 59.24 19.65, 52.62 26.3C48.7 30.24, 47.33 32.9, 48.68 33.97C49.59 34.68, 50.57 34.42, 53.61 32.67C58.94 29.6, 63.76 28.33, 67.92 28.91C72.08 29.49, 73.73 31.36, 73.05 34.72C71.16 43.99, 80.34 52.23, 89.45 49.45C96.16 47.41, 100.58 40.17, 99.8 32.51C98.69 21.57, 87.73 13.57, 75.54 14.81M65.61 45.51C64.14 46.29, 64.47 47.81, 66.8 50.88C70.34 55.56, 72.2 60.51, 72.21 65.33C72.23 70.17, 70.99 71.68, 67.62 70.94C58.84 69.01, 50.11 76.58, 50.42 85.84C50.88 99.25, 68.12 104.66, 80.08 95.14C90.46 86.87, 91.28 71.45, 82.02 58.3C81.81 58.01, 81.46 57.5, 81.23 57.18C76.68 50.64, 68.07 44.21, 65.61 45.51M13.53 46.34C3.46 47.89, -2.19 58.19, 1.38 68.51C6.84 84.35, 26.42 88.77, 43.99 78.14C51.6 73.54, 57.19 65.1, 53.45 63.86C52.45 63.53, 51.51 63.9, 49.09 65.57C43.39 69.51, 39.77 70.81, 34.91 70.68C29.11 70.52, 26.81 67.69, 28.45 62.74C29.51 59.55, 29.44 57.33, 28.2 54.4C25.82 48.8, 19.62 45.4, 13.53 46.34"

  func path(in rect: CGRect) -> Path {
    var path = Path()
    let scale = min(rect.width, rect.height) / 100
    let tokens = Self.d.replacingOccurrences(of: ",", with: " ")
      .replacingOccurrences(of: "M", with: " M ").replacingOccurrences(of: "C", with: " C ")
      .split(separator: " ")
    var i = 0, command = "M"
    func point() -> CGPoint {
      defer { i += 2 }
      return CGPoint(x: rect.minX + Double(tokens[i])! * scale, y: rect.minY + Double(tokens[i + 1])! * scale)
    }
    while i < tokens.count {
      if tokens[i] == "M" || tokens[i] == "C" { command = String(tokens[i]); i += 1; continue }
      if command == "M" { path.move(to: point()); command = "C" }
      else { let c1 = point(), c2 = point(), to = point(); path.addCurve(to: to, control1: c1, control2: c2) }
    }
    return path
  }
}

/// Wiva's cobalt, lighter on dark backgrounds.
let wivaBlue = Color(nsColor: NSColor(name: nil) { appearance in
  appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
    ? NSColor(red: 0.651, green: 0.749, blue: 1, alpha: 1) : NSColor(red: 0.153, green: 0.263, blue: 0.839, alpha: 1)
})

/// "Built by Wiva", linking to wiva.io.
struct BuiltByWiva: View {
  var body: some View {
    Link(destination: URL(string: "https://wiva.io")!) {
      HStack(spacing: 5) {
        Text("Built by").foregroundStyle(.secondary)
        WivaMark().fill(wivaBlue).frame(width: 13, height: 13)
        Text("Wiva").fontWeight(.semibold).foregroundStyle(.primary)
      }
      .font(.caption)
    }
    .buttonStyle(.plain)
  }
}

// MARK: - App

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
  private var item: NSStatusItem!
  private var status: Status = .notLinked
  private var timer: Timer?
  private var linkWindow: NSWindow?
  private var linkModel: LinkModel?
  private var pendingSite: String?
  private var updater: SPUStandardUpdaterController!

  func applicationWillFinishLaunching(_ notification: Notification) {
    NSAppleEventManager.shared().setEventHandler(
      self, andSelector: #selector(handleURL(_:reply:)),
      forEventClass: AEEventClass(kInternetEventClass), andEventID: AEEventID(kAEGetURL))
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    Task.detached {
      do {
        try syncBridge()
      } catch {
        await MainActor.run { self.alert("CodeRail can't start", error.localizedDescription) }
      }
    }
    updater = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    let menu = NSMenu()
    menu.delegate = self
    item.menu = menu
    show(currentStatus())
    timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { _ in
      Task { @MainActor in self.refresh() }
    }
    if status == .notLinked {
      showLink(site: pendingSite)
    } else if !UserDefaults.standard.bool(forKey: "loginItemOff") && SMAppService.mainApp.status != .enabled {
      // Linked: keep the menu bar app coming back at login (a replaced app can lose its registration),
      // unless the user turned that off.
      try? SMAppService.mainApp.register()
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    // (The Full Disk Access check is a launchd job: submitted jobs are relaunched until removed.)
    run("/bin/launchctl", ["remove", accessJob])
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    if status == .notLinked || status == .removed { showLink(site: nil) } else { item.button?.performClick(nil) }
    return false
  }

  /// coderail://link?server=https://… from the site's "Add a computer" page.
  @objc func handleURL(_ event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
    guard let s = event.paramDescriptor(forKeyword: keyDirectObject)?.stringValue,
      let comps = URLComponents(string: s)
    else { return }
    let server = comps.queryItems?.first(where: { $0.name == "server" })?.value
    if item == nil {
      pendingSite = server
    } else if status == .notLinked || status == .removed {
      showLink(site: server)
    } else {
      item.button?.performClick(nil)
    }
  }

  /// The status, read off the main thread (`launchctl print` can take a moment).
  private func refresh() {
    Task.detached {
      let s = currentStatus()
      await MainActor.run { self.show(s) }
    }
  }

  private func show(_ s: Status) {
    status = s
    let image = NSImage(named: "MenuBarIcon")
    image?.isTemplate = true
    image?.accessibilityDescription = "CodeRail: \(s.title)"
    item.button?.image = image
    item.button?.appearsDisabled = s != .connected
    item.button?.toolTip = "CodeRail: \(s.title)"
  }

  func menuNeedsUpdate(_ menu: NSMenu) {
    show(currentStatus())
    menu.removeAllItems()
    let config = readJSON(configPath, as: LinkConfig.self)
    let head = NSMenuItem(title: "CodeRail: \(status.title)", action: nil, keyEquivalent: "")
    head.isEnabled = false
    menu.addItem(head)
    if let config {
      let sub = NSMenuItem(title: "\"\(config.name)\" on \(URL(string: config.server)?.host ?? config.server)", action: nil, keyEquivalent: "")
      sub.isEnabled = false
      menu.addItem(sub)
    }
    menu.addItem(.separator())
    switch status {
    case .notLinked, .removed:
      menu.addItem(entry("Connect This Mac…", #selector(connect)))
    default:
      menu.addItem(entry("Open CodeRail", #selector(openSite), key: "o"))
      menu.addItem(.separator())
      if status == .paused {
        menu.addItem(entry("Resume", #selector(resume)))
      } else {
        menu.addItem(entry("Pause", #selector(pause)))
      }
      menu.addItem(entry("Show Log", #selector(showLog)))
      menu.addItem(entry("Full Disk Access…", #selector(fullDiskSettings)))
      menu.addItem(entry("Local Network…", #selector(localNetworkSettings)))
      menu.addItem(entry("Unlink This Mac…", #selector(unlink)))
    }
    menu.addItem(.separator())
    let check = NSMenuItem(title: "Check for Updates…", action: #selector(SPUStandardUpdaterController.checkForUpdates(_:)), keyEquivalent: "")
    check.target = updater
    menu.addItem(check)
    let login = entry("Show in Menu Bar at Login", #selector(toggleLogin))
    login.state = SMAppService.mainApp.status == .enabled ? .on : .off
    menu.addItem(login)
    menu.addItem(entry("Quit Menu Bar App", #selector(quit), key: "q"))
    menu.addItem(.separator())
    menu.addItem(entry("Built by Wiva", #selector(openWiva)))
  }

  private func entry(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
    let m = NSMenuItem(title: title, action: action, keyEquivalent: key)
    m.target = self
    return m
  }

  @objc func connect() { showLink(site: nil) }

  /// Privacy & Security › Full Disk Access, with CodeRail Bridge shown in Finder to drag into the list.
  @objc func fullDiskSettings() {
    openPrivacy("Privacy_AllFiles")
    NSWorkspace.shared.activateFileViewerSelecting([bridgeApp])
  }

  /// Privacy & Security › Local Network, where CodeRail Bridge is listed once it has asked.
  @objc func localNetworkSettings() { openPrivacy("Privacy_LocalNetwork") }

  private func openPrivacy(_ pane: String) {
    for s in ["x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?\(pane)",
              "x-apple.systempreferences:com.apple.preference.security?\(pane)"] {
      if let u = URL(string: s), NSWorkspace.shared.open(u) { break }
    }
  }

  private func showLink(site: String?) {
    let last = readJSON(configPath, as: LinkConfig.self)?.server
    if let linkWindow, let linkModel {
      if let site, case .enterSite = linkModel.phase { linkModel.site = site }
      NSApp.activate(ignoringOtherApps: true)
      linkWindow.makeKeyAndOrderFront(nil)
      return
    }
    let model = LinkModel(site: site ?? last ?? downloadedFromSite() ?? "")
    model.onLinked = { [weak self] in
      try? SMAppService.mainApp.register()
      self?.refresh()
    }
    let window = NSWindow(
      contentRect: .zero, styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.title = "CodeRail"
    window.isReleasedWhenClosed = false
    window.contentViewController = NSHostingController(
      rootView: LinkView(model: model) { [weak window] in window?.close() })
    window.center()
    NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) {
      [weak self] _ in
      Task { @MainActor in
        if case .approve = self?.linkModel?.phase { self?.linkModel?.cancel() }
        if case .working = self?.linkModel?.phase { self?.linkModel?.cancel() }
        self?.linkModel?.stopAccessCheck()
        self?.linkWindow = nil
        self?.linkModel = nil
      }
    }
    linkWindow = window
    linkModel = model
    NSApp.activate(ignoringOtherApps: true)
    window.makeKeyAndOrderFront(nil)
  }

  @objc func openSite() {
    guard let c = readJSON(configPath, as: LinkConfig.self), let u = URL(string: "\(c.server)/m/\(c.machineId)") else { return }
    NSWorkspace.shared.open(u)
  }

  @objc func pause() {
    run(binPath.path, ["service", "uninstall"])
    refresh()
  }

  @objc func resume() {
    run(binPath.path, ["service", "install"])
    refresh()
  }

  @objc func showLog() {
    NSWorkspace.shared.open(logPath)
  }

  @objc func unlink() {
    let a = NSAlert()
    a.messageText = "Unlink this Mac?"
    a.informativeText =
      "CodeRail stops running here and this Mac can't be reached from the site until you connect it again. Remove it on the site too if it's still listed."
    a.addButton(withTitle: "Unlink")
    a.addButton(withTitle: "Cancel")
    a.buttons[0].hasDestructiveAction = true
    NSApp.activate(ignoringOtherApps: true)
    guard a.runModal() == .alertFirstButtonReturn else { return }
    run(binPath.path, ["unlink"])
    try? FileManager.default.removeItem(at: statePath)
    refresh()
  }

  @objc func toggleLogin() {
    do {
      if SMAppService.mainApp.status == .enabled {
        try SMAppService.mainApp.unregister()
        UserDefaults.standard.set(true, forKey: "loginItemOff")
      } else {
        try SMAppService.mainApp.register()
        UserDefaults.standard.set(false, forKey: "loginItemOff")
      }
    } catch {
      alert("Couldn't change the login item", error.localizedDescription)
    }
  }

  @objc func quit() { NSApp.terminate(nil) }

  @objc func openWiva() { NSWorkspace.shared.open(URL(string: "https://wiva.io")!) }

  func alert(_ title: String, _ text: String) {
    let a = NSAlert()
    a.messageText = title
    a.informativeText = text
    NSApp.activate(ignoringOtherApps: true)
    a.runModal()
  }
}

MainActor.assumeIsolated {
  let app = NSApplication.shared
  let delegate = AppDelegate()
  app.delegate = delegate
  app.setActivationPolicy(.accessory)
  app.run()
}
