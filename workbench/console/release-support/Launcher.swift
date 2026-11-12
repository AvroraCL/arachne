import AppKit
import Foundation
import Darwin

let contents=URL(fileURLWithPath:CommandLine.arguments[0]).resolvingSymlinksInPath().deletingLastPathComponent().deletingLastPathComponent()
let resources=contents.appendingPathComponent("Resources")
let node=resources.appendingPathComponent("runtime/node/bin/node")
let scripts=resources.appendingPathComponent("workspace/workbench/console/scripts")

final class AppDelegate:NSObject,NSApplicationDelegate {
    var worker:Process?
    var buffer=""
    var failure=""
    var url:URL?
    var data:URL?
    var stopping=false
    var quitting=false
    var ownsService=false
    var workbench:NativeWorkbench?
    var commands:[NSMenuItem]=[]
    var openItem:NSMenuItem?
    var dataItem:NSMenuItem?
    var terminationSignal:DispatchSourceSignal?
    var version:String { Bundle.main.object(forInfoDictionaryKey:"ArachneReleaseVersion") as? String ?? "开发版" }

    func applicationDidFinishLaunching(_ notification:Notification) {
        signal(SIGTERM,SIG_IGN)
        terminationSignal=DispatchSource.makeSignalSource(signal:SIGTERM,queue:.main)
        terminationSignal?.setEventHandler { RunLoop.main.perform { NSApp.terminate(nil) } };terminationSignal?.resume()
        buildMenus()
        #if ARACHNE_DEV
        let configured=ProcessInfo.processInfo.environment["ARACHNE_DEV_URL"] ?? (Bundle.main.object(forInfoDictionaryKey:"ArachneDevelopmentURL") as? String ?? "")
        guard let address=URL(string:configured),validLocal(address) else {
            let alert=NSAlert();alert.messageText="无法打开开发工作台";alert.informativeText="请先启动本机 Web 服务，并使用 127.0.0.1 地址。";alert.runModal();NSApp.terminate(nil);return
        }
        ready(address,data:nil);return
        #else
        startWorker()
        #endif
    }

    func buildMenus() {
        let root=NSMenu();NSApp.mainMenu=root
        func group(_ title:String)->NSMenu { let item=NSMenuItem();root.addItem(item);let menu=NSMenu(title:title);item.submenu=menu;return menu }
        func command(_ menu:NSMenu,_ title:String,_ action:String,_ key:String="",_ modifiers:NSEvent.ModifierFlags=[.command]) {
            let item=menu.addItem(withTitle:title,action:#selector(nativeCommand(_:)),keyEquivalent:key)
            item.keyEquivalentModifierMask=modifiers;item.target=self;item.representedObject=action;item.isEnabled=false;commands.append(item)
        }
        let app=group("阿拉克涅")
        app.addItem(withTitle:"关于阿拉克涅",action:#selector(about),keyEquivalent:"").target=self
        command(app,"设置…","settings",",")
        app.addItem(.separator())
        openItem=app.addItem(withTitle:"打开工作台",action:#selector(openWorkspace),keyEquivalent:"");openItem?.target=self;openItem?.isEnabled=false
        dataItem=app.addItem(withTitle:"显示工程目录",action:#selector(showData),keyEquivalent:"");dataItem?.target=self;dataItem?.isEnabled=false
        app.addItem(.separator());app.addItem(withTitle:"隐藏阿拉克涅",action:#selector(NSApplication.hide(_:)),keyEquivalent:"h")
        app.addItem(withTitle:"退出阿拉克涅",action:#selector(NSApplication.terminate(_:)),keyEquivalent:"q")
        let file=group("文件")
        command(file,"新建工程…","newProject","n");command(file,"打开工程…","openProject","o")
        command(file,"打开涂装 ZIP…","importArchive");command(file,"迁移为 GLB 工程…","migrateModel")
        file.addItem(.separator());command(file,"保存工程","save","s")
        command(file,"另存为工程…","saveProjectCopy","s",[.command,.shift])
        command(file,"生成工程副本","createBackup");command(file,"下载工程副本…","downloadBackup")
        command(file,"工程详情…","projectDetails");file.addItem(.separator());command(file,"导出…","export","e")
        let edit=group("编辑")
        command(edit,"撤销","undo","z");command(edit,"重做","redo","z",[.command,.shift]);edit.addItem(.separator())
        command(edit,"剪切","cut","x")
        for (title,selector,key) in [("拷贝","copy:","c"),("粘贴","paste:","v"),("全选","selectAll:","a")] {
            edit.addItem(withTitle:title,action:Selector(selector),keyEquivalent:key)
        }
        command(edit,"原位粘贴","pasteInPlace","v",[.command,.shift])
        edit.addItem(.separator());command(edit,"历史记录…","history");command(edit,"搜索命令…","searchCommands","k")
        let render=group("渲染");command(render,"渲染设置","renderSettings");command(render,"后台任务…","renderTasks")
        let window=group("窗口");command(window,"工作区布局…","workspaceLayouts");window.addItem(.separator())
        window.addItem(withTitle:"最小化",action:#selector(NSWindow.performMiniaturize(_:)),keyEquivalent:"m")
        window.addItem(withTitle:"关闭窗口",action:#selector(NSWindow.performClose(_:)),keyEquivalent:"w")
        let full=window.addItem(withTitle:"切换全屏",action:#selector(NSWindow.toggleFullScreen(_:)),keyEquivalent:"f");full.keyEquivalentModifierMask=[.control,.command]
        NSApp.windowsMenu=window
    }

    func validLocal(_ url:URL)->Bool {
        return url.scheme=="http" && url.host=="127.0.0.1" && url.user==nil && url.password==nil && (url.port ?? 0)>=1024 && (url.port ?? 0)<=65535
    }

    func startWorker() {
        let process=Process(),output=Pipe(),errors=Pipe();worker=process
        process.executableURL=node;process.arguments=[scripts.appendingPathComponent("release-runtime.mjs").path]
        process.currentDirectoryURL=scripts.deletingLastPathComponent();process.standardOutput=output;process.standardError=errors
        output.fileHandleForReading.readabilityHandler={ [weak self] handle in
            let bytes=handle.availableData;if bytes.isEmpty{handle.readabilityHandler=nil;return}
            let text=String(decoding:bytes,as:UTF8.self)
            DispatchQueue.main.async { self?.receive(text) }
        }
        errors.fileHandleForReading.readabilityHandler={ [weak self] handle in
            let bytes=handle.availableData;if bytes.isEmpty{handle.readabilityHandler=nil;return}
            let text=String(decoding:bytes,as:UTF8.self)
            DispatchQueue.main.async { self?.failure=String(((self?.failure ?? "")+text).suffix(4000)) }
        }
        process.terminationHandler={ [weak self] process in
            RunLoop.main.perform(inModes:[.default,.modalPanel,.eventTracking]) {
                guard let self=self else{return}
                if self.stopping { NSApp.reply(toApplicationShouldTerminate:true);return }
                let alert=NSAlert();alert.messageText="阿拉克涅未能继续运行";alert.informativeText=self.failure.isEmpty ? "请重新打开应用，或查看工程目录中的 logs 文件夹。" : self.failure
                alert.runModal();NSApp.terminate(nil)
            }
        }
        do { try process.run() } catch { failure=error.localizedDescription;let alert=NSAlert();alert.messageText="无法启动阿拉克涅";alert.informativeText=failure;alert.runModal();NSApp.terminate(nil) }
    }

    func receive(_ text:String) {
        buffer+=text
        while let end=buffer.firstIndex(of:"\n") {
            let line=String(buffer[..<end]);buffer=String(buffer[buffer.index(after:end)...])
            guard line.hasPrefix("ARACHNE_READY "),let bytes=String(line.dropFirst(14)).data(using:.utf8),let value=try? JSONSerialization.jsonObject(with:bytes) as? [String:Any],let address=value["url"] as? String,let parsed=URL(string:address),validLocal(parsed) else{continue}
            var target=parsed
            let folder=(value["data"] as? String).flatMap { $0.hasPrefix("/") ? URL(fileURLWithPath:$0,isDirectory:true) : nil }
            if let folder=folder, let remembered=lastProject(in:folder),
               var components=URLComponents(url:parsed,resolvingAgainstBaseURL:false) {
                var items=(components.queryItems ?? []).filter{$0.name != "project"};items.append(URLQueryItem(name:"project",value:remembered));components.queryItems=items
                target=components.url ?? parsed
            }
            ownsService=value["owned"] as? Bool ?? false
            ready(target,data:folder)
        }
    }

    private func desktopState(_ folder:URL) -> URL {
        folder.deletingLastPathComponent().appendingPathComponent("desktop.json")
    }

    private func lastProject(in folder:URL) -> String? {
        let file=desktopState(folder)
        let saved=(try? Data(contentsOf:file)).flatMap { try? JSONSerialization.jsonObject(with:$0) as? [String:Any] }
        let previous=ProcessInfo.processInfo.environment["ARACHNE_USER_DATA_DIR"]==nil ? UserDefaults.standard.string(forKey:"lastProjectId") : nil
        return [saved?["project"] as? String,previous].compactMap{$0}.first { id in
            id.range(of:"^[A-Za-z0-9_-]{1,100}$",options:.regularExpression) != nil &&
            FileManager.default.fileExists(atPath:folder.appendingPathComponent("projects").appendingPathComponent(id).appendingPathComponent("project.json").path)
        }
    }

    private func rememberProject(_ id:String) {
        guard let folder=data else{return}
        do {
            let state=try JSONSerialization.data(withJSONObject:["project":id])
            try state.write(to:desktopState(folder),options:.atomic)
        } catch { NSLog("无法保存最近打开的工程：%@",error.localizedDescription) }
    }

    func ready(_ address:URL,data:URL?) {
        url=address;self.data=data;openItem?.isEnabled=true;dataItem?.isEnabled=data != nil
        commands.forEach{$0.isEnabled=true}
        if ProcessInfo.processInfo.environment["ARACHNE_LAUNCH_NO_OPEN"] != "1" { openWorkspace() }
    }
    @objc func nativeCommand(_ sender:NSMenuItem) {
        guard let action=sender.representedObject as? String else{return}
        if workbench==nil { openWorkspace() }
        guard let view=workbench else{return}
        if !view.window.isVisible { view.show() }
        view.perform(action)
    }
    @objc func openWorkspace() {
        guard let url=url else{return}
        if workbench==nil {
            let view=NativeWorkbench(url:url)
            view.onProject={ [weak self] id,_ in self?.rememberProject(id) }
            workbench=view
        }
        workbench?.show()
    }
    @objc func showData() { if let data=data { NSWorkspace.shared.open(data) } }
    @objc func about() { let alert=NSAlert();alert.messageText="阿拉克涅 \(version)";alert.informativeText="建模 · 材质 · 绘制\nMac 窗口 · 本机工作台";alert.runModal() }
    func applicationShouldHandleReopen(_ sender:NSApplication,hasVisibleWindows flag:Bool)->Bool { openWorkspace();return false }

    // The owned service can also be used by MCP or another project window.
    // Check all projects before stopping it, not just the currently open one.
    func serviceActivity(_ completion:@escaping (String)->Void) {
        guard let address=url, var base=URLComponents(url:address,resolvingAgainstBaseURL:false) else { completion("unavailable");return }
        base.path="/api/desktop-activity";base.query=nil;base.fragment=nil
        guard let activityURL=base.url else { completion("unavailable");return }
        let configuration=URLSessionConfiguration.ephemeral;configuration.timeoutIntervalForRequest=5
        let session=URLSession(configuration:configuration)
        session.dataTask(with:activityURL) { data,response,error in
            let activity=data.flatMap{(try? JSONDecoder().decode([String:String].self,from:$0))?["state"]}
            let state=(error==nil && (response as? HTTPURLResponse)?.statusCode==200 && ["ready","saving","jobs"].contains(activity ?? ""))
                ? activity ?? "unavailable" : "unavailable"
            DispatchQueue.main.async { session.finishTasksAndInvalidate();completion(state) }
        }.resume()
    }

    func confirmQuit(_ state:String,workbench:NativeWorkbench)->Bool {
        if state=="ready" || (state=="jobs" && !ownsService) { return true }
        workbench.show()
        let alert=NSAlert()
        switch state {
        case "saving":alert.messageText="正在保存或导入工程";alert.informativeText="请等待当前操作完成后再退出。"
        case "editing":alert.messageText="仍有操作未完成";alert.informativeText="请先确认或取消当前编辑，再退出。"
        case "error":alert.messageText="工程保存失败";alert.informativeText="退出可能丢失未保存的修改。"
        case "jobs":alert.messageText="后台任务正在运行";alert.informativeText="退出会中断由此应用启动的后台任务。"
        case "downloads":alert.messageText="文件正在下载";alert.informativeText="退出会中断下载。"
        default:alert.messageText="无法检查保存或任务状态";alert.informativeText="退出可能丢失未保存的修改或中断任务。"
        }
        alert.addButton(withTitle:"返回工作台")
        if !["saving","editing"].contains(state) { alert.addButton(withTitle:"仍要退出") }
        return alert.runModal() == .alertSecondButtonReturn
    }

    func finishQuit(_ proceed:Bool) {
        quitting=false
        if proceed {
            if stopWorker() == .terminateNow { NSApp.reply(toApplicationShouldTerminate:true) }
        } else { NSApp.reply(toApplicationShouldTerminate:false) }
    }

    func applicationShouldTerminate(_ sender:NSApplication)->NSApplication.TerminateReply {
        if quitting || stopping { return .terminateLater }
        guard let workbench=workbench else { return stopWorker() }
        quitting=true
        workbench.prepareToQuit { [weak self] state in
            guard let self=self else { NSApp.reply(toApplicationShouldTerminate:false);return }
            guard self.ownsService && ["ready","jobs"].contains(state) else {
                self.finishQuit(self.confirmQuit(state,workbench:workbench));return
            }
            self.serviceActivity { check in
                self.finishQuit(self.confirmQuit(check,workbench:workbench))
            }
        }
        return .terminateLater
    }
    func stopWorker()->NSApplication.TerminateReply {
        guard let worker=worker,worker.isRunning else{return .terminateNow}
        if stopping{return .terminateLater};stopping=true;worker.terminate();return .terminateLater
    }
}

@main struct ArachneLauncher {
    static func main() {
        if URL(fileURLWithPath:CommandLine.arguments[0]).lastPathComponent == "ArachneMCP" {
            let args=[node.path,scripts.appendingPathComponent("release-mcp.mjs").path]+Array(CommandLine.arguments.dropFirst())
            let pointers=args.map { strdup($0) }+[nil]
            pointers.withUnsafeBufferPointer { _ = execv(node.path,$0.baseAddress!) }
            fputs("Cannot start bundled MCP runtime\n",stderr);exit(1)
        }
        let app=NSApplication.shared,delegate=AppDelegate();app.delegate=delegate;app.setActivationPolicy(.regular);app.run()
    }
}
