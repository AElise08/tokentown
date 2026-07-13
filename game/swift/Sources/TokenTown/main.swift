// TOKENTOWN — casca NATIVA macOS (AppKit + WebKit), substituta leve do Electron.
// Reusa o renderer (game.js VERBATIM) e o CÉREBRO (reader.js, portado de main.js+
// placar.js) dentro de um WKWebView. O Swift faz SÓ o que o navegador não pode:
//   • I/O de arquivo: enumerar ~/.claude/projects/**/*.jsonl, leitura incremental
//     por offset, tails p/ o estado, sinais de atividade dos tasks/*.output, e ler
//     ~/.tokentown-placar.json;
//   • a rede: POST do report ao placar (URLSession — imune a CORS/ATS do file://);
//   • a janela transparente sempre-no-topo, o arrastar, o fechar e as notificações.
// Toda a lógica testada (dedupe/backfill/estado/custo/setup/sanitização) roda no JS.

import AppKit
import WebKit
import UserNotifications

// ===========================================================================
// TEMPORADAS — MESMA fórmula do main.js/placar.js (as "3 linhas" a manter em sync).
// ===========================================================================
enum Season {
    static let epochMs: Double = {
        var c = DateComponents()
        c.year = 2026; c.month = 7; c.day = 1
        c.hour = 0; c.minute = 0; c.second = 0
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let d = cal.date(from: c)!
        return d.timeIntervalSince1970 * 1000.0
    }()
    static let spanMs: Double = 28.0 * 86400000.0
    static func currentId(_ nowMs: Double) -> Int { Int(floor((nowMs - epochMs) / spanMs)) }
    static func startMs(_ nowMs: Double) -> Double { epochMs + Double(currentId(nowMs)) * spanMs }
}

let RECENT_MS: Double = 30 * 60000
let TAIL_BYTES: Int = 64 * 1024

func nowMs() -> Double { Date().timeIntervalSince1970 * 1000.0 }

// ===========================================================================
// JANELA — borderless PRECISA poder virar KEY/MAIN, senão o teclado (setas/espaço
// do recreio) nunca chega na WKWebView (janela sem título não vira key por padrão).
// ===========================================================================
final class KeyableWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}
// WKWebView que aceita o PRIMEIRO clique (app acessório/inativo): o clique já vale
// como interação (pula no recreio) em vez de só ativar a janela.
final class OverlayWebView: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

// ===========================================================================
// LOG — grava em ~/Library/Logs/TokenTown/run.log (e também no stderr).
// ===========================================================================
final class Log {
    static let shared = Log()
    private let url = URL(fileURLWithPath: NSHomeDirectory())
        .appendingPathComponent("Library/Logs/TokenTown/run.log")   // portátil (log padrão do macOS), não amarra ao path do projeto
    private let q = DispatchQueue(label: "tt.log")
    private var handle: FileHandle?
    private let fmt: DateFormatter = {
        let f = DateFormatter(); f.dateFormat = "HH:mm:ss.SSS"; return f
    }()
    init() {
        let fm = FileManager.default
        try? fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !fm.fileExists(atPath: url.path) { fm.createFile(atPath: url.path, contents: nil) }
        handle = try? FileHandle(forWritingTo: url)
        _ = try? handle?.seekToEnd()
    }
    func line(_ s: String) {
        let msg = "[\(fmt.string(from: Date()))] \(s)\n"
        q.async {
            if let d = msg.data(using: .utf8) { try? self.handle?.write(contentsOf: d) }
            FileHandle.standardError.write(msg.data(using: .utf8) ?? Data())
        }
    }
}
func log(_ s: String) { Log.shared.line(s) }

// ===========================================================================
// FS — enumeração/leitura de arquivos (tudo na ioQueue).
// ===========================================================================
final class FS {
    static let projects = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".claude/projects")
    static let placarConfig = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".tokentown-placar.json")
    static let settingsJson = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".claude/settings.json")
    static let stateFile = URL(fileURLWithPath: NSHomeDirectory())
        .appendingPathComponent("Library/Application Support/TokenTownSwift/state.json")

    static func listJsonl() -> [String] {
        var out: [String] = []
        guard let en = FileManager.default.enumerator(at: projects,
              includingPropertiesForKeys: [.isRegularFileKey], options: []) else { return out }
        for case let u as URL in en where u.pathExtension == "jsonl" { out.append(u.path) }
        return out
    }
    static func taskOutputs() -> [String] {
        let base = "/private/tmp/claude-\(getuid())"
        var out: [String] = []
        let alt = "/tmp/claude-\(getuid())"
        let dir = FileManager.default.fileExists(atPath: base) ? base
                : (FileManager.default.fileExists(atPath: alt) ? alt : nil)
        guard let d = dir, let en = FileManager.default.enumerator(atPath: d) else { return out }
        for case let p as String in en where p.hasSuffix(".output") { out.append(d + "/" + p) }
        return out
    }
    static func mtimeMs(_ path: String) -> Double? {
        guard let a = try? FileManager.default.attributesOfItem(atPath: path),
              let m = a[.modificationDate] as? Date else { return nil }
        return m.timeIntervalSince1970 * 1000.0
    }
    static func size(_ path: String) -> UInt64? {
        guard let a = try? FileManager.default.attributesOfItem(atPath: path),
              let s = a[.size] as? UInt64 else { return nil }
        return s
    }
    // lê [offset..EOF]; devolve o texto SÓ das linhas completas + o novo offset (após o últ \n).
    static func readFrom(_ path: String, offset: UInt64) -> (text: String, newOffset: UInt64, grew: Bool)? {
        guard let sz = size(path) else { return nil }
        var off = offset
        if off > sz { off = 0 } // truncou/rotacionou
        let grew = sz > off
        if sz <= off { return ("", off, false) }
        guard let fh = try? FileHandle(forReadingFrom: URL(fileURLWithPath: path)) else { return ("", off, grew) }
        defer { try? fh.close() }
        try? fh.seek(toOffset: off)
        let data = (try? fh.readToEnd()) ?? Data()
        guard let nl = data.lastIndex(of: 0x0A) else {
            return ("", off, grew) // ganhou bytes mas sem linha completa ainda -> atividade
        }
        let complete = data.subdata(in: data.startIndex..<(nl + 1))
        let text = String(decoding: complete, as: UTF8.self)
        return (text, off + UInt64(complete.count), grew)
    }
    // lê o arquivo inteiro; devolve (texto, offsetBaseline após o últ \n).
    static func readAll(_ path: String) -> (text: String, baseline: UInt64)? {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else { return nil }
        let text = String(decoding: data, as: UTF8.self)
        if let nl = data.lastIndex(of: 0x0A) { return (text, UInt64(nl + 1)) }
        return (text, 0)
    }
    static func readTail(_ path: String) -> String {
        guard let sz = size(path) else { return "" }
        guard let fh = try? FileHandle(forReadingFrom: URL(fileURLWithPath: path)) else { return "" }
        defer { try? fh.close() }
        let start = sz > UInt64(TAIL_BYTES) ? sz - UInt64(TAIL_BYTES) : 0
        try? fh.seek(toOffset: start)
        let data = (try? fh.readToEnd()) ?? Data()
        return String(decoding: data, as: UTF8.self)
    }
    static func readJSON(_ url: URL) -> Any? {
        guard let d = try? Data(contentsOf: url) else { return nil }
        return try? JSONSerialization.jsonObject(with: d)
    }
}

// ===========================================================================
// APP DELEGATE
// ===========================================================================
final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var webView: WKWebView!
    let ioQueue = DispatchQueue(label: "tt.io")
    // estado do I/O (só tocado na ioQueue)
    var offsets: [String: UInt64] = [:]
    var taskSizes: [String: UInt64] = [:]
    var seasonStartMs: Double = Season.startMs(nowMs())
    var maxMtimePath: String? = nil
    var pollTimer: Timer?
    var notificationsReady = false
    var polling = false

    func applicationDidFinishLaunching(_ n: Notification) {
        NSApp.setActivationPolicy(.accessory) // utilitário/overlay: sem ícone no Dock
        log("=== TOKENTOWN swift boot === pid \(getpid()) resources=\(Bundle.main.resourceURL?.path ?? "?")")
        setupWindow()
        setupNotifications()
    }

    // ------- janela transparente sempre-no-topo, canto inferior direito -------
    func setupWindow() {
        let W: CGFloat = 320, H: CGFloat = 360
        let screen = NSScreen.main ?? NSScreen.screens.first
        let vf = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let x = vf.maxX - W - 24
        let y = vf.minY + 24
        window = KeyableWindow(contentRect: NSRect(x: x, y: y, width: W, height: H),
                          styleMask: [.borderless], backing: .buffered, defer: false)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.isMovableByWindowBackground = false // arraste tratado via performDrag na barra
        window.ignoresMouseEvents = false

        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(self, name: "tt")
        webView = OverlayWebView(frame: NSRect(x: 0, y: 0, width: W, height: H), configuration: cfg)
        webView.autoresizingMask = [.width, .height]
        webView.setValue(false, forKey: "drawsBackground") // fundo transparente do webview
        webView.navigationDelegate = self

        window.contentView = webView
        window.orderFrontRegardless()
        // no boot NÃO roubamos foco do que a Mel faz; mas já deixamos a WKWebView como
        // first responder pra que, assim que a janela virar key (ao clicar no recreio),
        // o teclado flua direto pro jogo.
        window.makeFirstResponder(webView)

        guard let res = Bundle.main.resourceURL else { log("ERRO: sem resourceURL"); return }
        let html = res.appendingPathComponent("overlay-swift.html")
        _ = webView.loadFileURL(html, allowingReadAccessTo: res)
        log("webview loadFileURL \(html.lastPathComponent)")
    }

    func setupNotifications() {
        guard Bundle.main.bundleIdentifier != nil else { log("notif: sem bundleId, pulando"); return }
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, err in
            self.notificationsReady = granted
            log("notif auth granted=\(granted) err=\(err?.localizedDescription ?? "nil")")
        }
    }

    // WKNavigationDelegate: página carregada -> arranca o cérebro.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        log("webview didFinish -> iniciando cérebro")
        startBrain()
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        log("webview didFail: \(error.localizedDescription)")
    }

    // ------------------- ponte JS -> Swift (× fechar / arrastar) -------------------
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let dict = message.body as? [String: Any], let type = dict["type"] as? String else { return }
        switch type {
        case "close":
            log("UI: close -> terminate")
            NSApp.terminate(nil)
        case "drag":
            if let ev = NSApp.currentEvent { window.performDrag(with: ev) }
        case "focus":
            // a Mel abriu o recreio: ativamos o app (acessório), tornamos a janela KEY e
            // a WKWebView first responder — só ASSIM o teclado (setas/espaço) chega no jogo.
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
            window.makeFirstResponder(webView)
            log("UI: focus -> janela key + webview first responder (recreio)")
        default: break
        }
    }

    // =======================================================================
    // CÉREBRO: init -> backfill -> poll (I/O na ioQueue, JS no main thread).
    // =======================================================================
    func startBrain() {
        ioQueue.async {
            self.seasonStartMs = Season.startMs(nowMs())
            let disk = FS.readJSON(FS.stateFile)
            let settings = FS.readJSON(FS.settingsJson) as? [String: Any]
            var hooks: [String] = []
            if let h = settings?["hooks"] as? [String: Any] { hooks = Array(h.keys) }
            let now = nowMs()
            DispatchQueue.main.async {
                let args: [String: Any] = ["disk": disk ?? NSNull(), "hooks": hooks, "now": now]
                self.callJS("return window.__tt.init(disk, hooks, now);", args) { res in
                    if case let .success(v) = res, let d = v as? [String: Any],
                       let ss = d["seasonStart"] as? Double { self.seasonStartMs = ss }
                    log("init ok seasonStart=\(self.seasonStartMs)")
                    self.runBackfill()
                }
            }
        }
    }

    // Backfill: só arquivos com mtime>=seasonStart têm linhas in-season; os demais
    // recebem só o offset baseline (=EOF). Serializa 1 arquivo por vez pelo bridge.
    func runBackfill() {
        ioQueue.async {
            let files = FS.listJsonl()
            var toScan: [String] = []
            var skipped = 0
            for f in files {
                let mt = FS.mtimeMs(f) ?? 0
                if mt >= self.seasonStartMs {
                    toScan.append(f)
                } else {
                    self.offsets[f] = FS.size(f) ?? 0 // baseline sem enviar conteúdo
                    skipped += 1
                }
            }
            log("backfill: \(files.count) arquivos, \(toScan.count) in-season, \(skipped) pulados por mtime")
            DispatchQueue.main.async {
                self.callJS("window.__tt.backfillStart(now);", ["now": nowMs()]) { _ in
                    self.backfillNext(toScan, 0)
                }
            }
        }
    }
    func backfillNext(_ files: [String], _ i: Int) {
        // recursão dirigida pelo completion handler (serializa os envios grandes).
        if i >= files.count {
            callJS("return window.__tt.backfillDone(now);", ["now": nowMs()]) { res in
                if case let .success(v) = res, let d = v as? [String: Any] {
                    let tk = (d["tokens"] as? Double) ?? -1
                    let cost = (d["cost"] as? Double) ?? -1
                    let ag = (d["subagents"] as? Double) ?? -1
                    let sid = (d["seasonId"] as? Double) ?? -1
                    log("BACKFILL DONE T\(Int(sid)): tokens=\(Int(tk)) custo=US$\(cost) moradores=\(Int(ag)) diario=\((d["daily"] as? String) ?? "?")")
                    log("BACKFILL setup=\((d["setup"] as? String) ?? "?")")
                }
                self.startPolling()
            }
            return
        }
        let f = files[i]
        ioQueue.async {
            guard let r = FS.readAll(f) else {
                self.offsets[f] = FS.size(f) ?? 0
                DispatchQueue.main.async { self.backfillNext(files, i + 1) }
                return
            }
            self.offsets[f] = r.baseline
            let content = r.text
            DispatchQueue.main.async {
                self.callJS("window.__tt.backfillFile(content, now);",
                            ["content": content, "now": nowMs()]) { _ in
                    self.backfillNext(files, i + 1)
                }
            }
        }
    }

    func startPolling() {
        log("polling ~1.5s iniciado")
        // 1º poll imediato, depois timer.
        pollOnce()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { _ in self.pollOnce() }
        // refresca o setup a cada 5min (como o Electron).
        Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { _ in
            self.callJS("window.__tt.tickSetup();", [:], nil)
        }
        // verificação: ~35s depois, loga o estado interno vivo (city populada etc.).
        Timer.scheduledTimer(withTimeInterval: 35, repeats: false) { _ in
            self.callJS("return window.__tt.peek();", [:]) { res in
                if case let .success(v) = res, let d = v as? [String: Any] {
                    log("PEEK@35s tokens=\(Int((d["seasonTokens"] as? Double) ?? -1)) moradores=\(Int((d["subagents"] as? Double) ?? -1)) hasCity=\((d["hasCity"] as? Bool) ?? false) state=\((d["lastAlertState"] as? String) ?? "?") daily=\((d["daily"] as? String) ?? "?")")
                    if let city = d["city"] as? String { log("PEEK@35s city=\(city)") }
                }
            }
        }
    }

    func pollOnce() {
        if polling { return }
        polling = true
        ioQueue.async {
            let now = nowMs()
            var files: [[String: Any]] = []
            var maxMt: Double = -1
            var maxPath: String? = nil
            var recent: [[String: Any]] = []
            for f in FS.listJsonl() {
                // incremental
                if let r = FS.readFrom(f, offset: self.offsets[f] ?? 0) {
                    if r.grew {
                        self.offsets[f] = r.newOffset
                        files.append(["path": f, "newText": r.text])
                    } else {
                        self.offsets[f] = r.newOffset
                    }
                }
                // recentes (p/ o estado) + maxMtime (fallback do transcrito ativo)
                if let mt = FS.mtimeMs(f) {
                    if now - mt <= RECENT_MS {
                        recent.append(["path": f, "mtimeMs": mt, "tail": FS.readTail(f)])
                    }
                    let isSub = f.contains("/subagents/")
                    if !isSub && mt > maxMt { maxMt = mt; maxPath = f }
                }
            }
            self.maxMtimePath = maxPath
            var maxObj: Any = NSNull()
            if let mp = maxPath { maxObj = ["path": mp, "tail": FS.readTail(mp)] }
            // sinal de atividade dos subagentes em background (tasks/*.output crescendo)
            var taskGrew = false
            for t in FS.taskOutputs() {
                guard let sz = FS.size(t) else { continue }
                if let prev = self.taskSizes[t], sz > prev { taskGrew = true }
                self.taskSizes[t] = sz
            }
            // config do placar (re-lida a cada poll, como o placar.js)
            let cfg = FS.readJSON(FS.placarConfig) ?? NSNull()
            let payload: [String: Any] = [
                "files": files, "taskGrew": taskGrew, "recent": recent,
                "maxMtimeFile": maxObj, "config": cfg
            ]
            DispatchQueue.main.async {
                self.callJS("return window.__tt.poll(payload, now);",
                            ["payload": payload, "now": nowMs()]) { res in
                    self.polling = false
                    if case let .success(v) = res, let d = v as? [String: Any] {
                        self.handlePollResult(d)
                    } else if case let .failure(e) = res {
                        log("poll JS erro: \(e.localizedDescription)")
                    }
                }
            }
        }
    }

    func handlePollResult(_ d: [String: Any]) {
        // notificação nativa na transição (suprime se a janela estiver focada).
        if let kind = d["notify"] as? String { maybeNotify(kind) }
        // report: o JS já montou/sanitizou o corpo; o Swift posta (URLSession).
        if let rep = d["report"] as? [String: Any],
           let url = rep["url"] as? String, let body = rep["body"] as? [String: Any] {
            postReport(url: url, body: body)
            persistState(body) // aproveita p/ gravar o state.json local
        }
    }

    // ------------------- report -> placar (URLSession, imune a CORS) -------------------
    func postReport(url: String, body: [String: Any]) {
        guard let u = URL(string: url) else { return }
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { return }
        var req = URLRequest(url: u)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = data
        let tokens = (body["tokens"] as? Int) ?? Int((body["tokens"] as? Double) ?? 0)
        let hasCity = body["city"] != nil
        URLSession.shared.dataTask(with: req) { respData, resp, err in
            if let e = err {
                log("REPORT falhou (rede): \(e.localizedDescription)")
                return
            }
            let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
            let bodyStr = respData.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            log("REPORT POST \(url) -> HTTP \(code) tokens=\(tokens) city=\(hasCity) resp=\(bodyStr.prefix(160))")
        }.resume()
    }

    func persistState(_ body: [String: Any]) {
        let state: [String: Any] = [
            "seasonId": body["seasonId"] ?? 0,
            "tokens": body["tokens"] ?? 0,
            "costUSD": body["cost"] ?? 0,
            "residents": body["residents"] ?? 0,
            "history": []
        ]
        ioQueue.async {
            try? FileManager.default.createDirectory(at: FS.stateFile.deletingLastPathComponent(),
                                                     withIntermediateDirectories: true)
            if let d = try? JSONSerialization.data(withJSONObject: state) {
                try? d.write(to: FS.stateFile)
            }
        }
    }

    // ------------------- notificação nativa -------------------
    func maybeNotify(_ kind: String) {
        // suprime se a janela do overlay estiver em foco (a Mel já está olhando).
        let focused = window.isKeyWindow && NSApp.isActive
        if focused { log("notify \(kind) suprimida (janela focada)"); return }
        guard notificationsReady else { log("notify \(kind) ignorada (sem permissão)"); return }
        let content = UNMutableNotificationContent()
        if kind == "decision" {
            content.title = "TOKENTOWN — precisa da sua decisão"
            content.body = "o agente está te esperando"
        } else {
            content.title = "TOKENTOWN — o agente terminou"
            content.body = "sua vez"
        }
        content.sound = .default
        let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req) { err in
            if let e = err { log("notify add erro: \(e.localizedDescription)") }
            else { log("notify \(kind) mostrada") }
        }
    }

    // helper: callAsyncJavaScript no contentWorld da página.
    func callJS(_ body: String, _ args: [String: Any], _ done: ((Result<Any, Error>) -> Void)?) {
        webView.callAsyncJavaScript(body, arguments: args, in: nil, in: .page) { result in
            switch result {
            case .success(let v): done?(.success(v))
            case .failure(let e): done?(.failure(e))
            }
        }
    }
}

// ===========================================================================
// BOOT
// ===========================================================================
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
