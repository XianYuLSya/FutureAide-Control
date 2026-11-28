// Windows Script Host JScript. Read the same local WMI providers used by the
// PowerShell fallback without starting PowerShell or importing its TCP module.
var args = WScript.Arguments;
var processes = GetObject("winmgmts:\\\\.\\root\\cimv2");
var sockets = GetObject("winmgmts:\\\\.\\root\\StandardCimv2");
var files = new ActiveXObject("Scripting.FileSystemObject");

function rows(service, sql) {
  return new Enumerator(service.ExecQuery(sql, "WQL", 48));
}

function pidArgument(value) {
  if (!/^[1-9]\d*$/.test(value)) throw new Error("Invalid process identity");
  return value;
}

function stamp(value) {
  var text = String(value);
  if (!/^\d{14}\.\d{6}[+-]\d{3}$/.test(text)) throw new Error("Missing creation time");
  return text;
}

function main() {
  var caller = rows(processes, "SELECT SessionId FROM Win32_Process WHERE ProcessId=" + pidArgument(args.Item(0)));
  if (caller.atEnd()) throw new Error("Caller process missing");
  var session = " AND SessionId=" + Number(caller.item().SessionId);
  var names = "(Name='ChatGPT.exe' OR Name='Codex.exe')";
  var filter = names + session;
  if (args.length > 1) {
    var pid = pidArgument(args.Item(1));
    var other = rows(processes, "SELECT ProcessId FROM Win32_Process WHERE " + filter +
      " AND ProcessId<>" + pid + " AND CommandLine LIKE '%--remote-debugging-port=%' AND NOT CommandLine LIKE '%--type=%'");
    if (!other.atEnd()) return;
    filter = "ProcessId=" + pid + session;
  }
  var candidates = rows(processes, "SELECT Name,ProcessId,ExecutablePath,CommandLine,CreationDate FROM Win32_Process WHERE " + filter);
  for (; !candidates.atEnd(); candidates.moveNext()) {
    var app = candidates.item();
    var executable = app.ExecutablePath;
    var command = app.CommandLine || "";
    if (!/^(ChatGPT|Codex)\.exe$/i.test(app.Name) || !executable ||
        !/--remote-debugging-port=/i.test(command) || /--type=/i.test(command)) continue;
    if (!/\\WindowsApps\\OpenAI\.Codex_/i.test(executable) &&
        !files.FileExists(files.BuildPath(files.GetParentFolderName(executable),
          "resources\\plugins\\openai-bundled\\plugins\\codex-app-tools\\server.mjs"))) continue;
    var portArgs = /(?:^|[\s"])--remote-debugging-port=(?:"([^"]*)"|([^\s"]*))(?=$|[\s"])/ig;
    var first = portArgs.exec(command);
    var value = first && (first[1] || first[2]);
    var fixed = !portArgs.exec(command) && /^\d{1,5}$/.test(value) && Number(value) > 0 && Number(value) <= 65535 ? Number(value) : 0;
    var id = Number(app.ProcessId);
    var listeners = rows(sockets, "SELECT OwningProcess,LocalPort,CreationTime FROM MSFT_NetTCPConnection" +
      " WHERE State=2 AND LocalAddress='127.0.0.1' AND OwningProcess=" + id + (fixed ? " AND LocalPort=" + fixed : ""));
    for (; !listeners.atEnd(); listeners.moveNext()) {
      var listener = listeners.item();
      WScript.Echo([id, Number(listener.LocalPort), stamp(app.CreationDate), stamp(listener.CreationTime), fixed].join("\t"));
    }
  }
}

main();
// A disabled script host may exit successfully with only a localized notice.
WScript.Echo("OK");
