// Windows Job Object process cage (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) and
// zero-PowerShell Win32 process inspection & broken-parent-chain orphan sweep.
//
// Zero third-party npm dependencies: compiles a tiny native-speed C# P/Invoke
// helper once into os.tmpdir() using Windows' built-in .NET Framework csc.exe,
// with graceful fallback when running on non-Windows or stripped environments.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const HELPER_TIMEOUT_MS = 15000;
const CAGE_READY_TIMEOUT_MS = 8000;

const CSHARP_HELPER_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class Program {
  private const uint SYNCHRONIZE = 0x00100000;
  private const uint PROCESS_TERMINATE = 0x0001;
  private const uint PROCESS_VM_READ = 0x0010;
  private const uint PROCESS_SET_QUOTA = 0x0100;
  private const uint PROCESS_QUERY_INFORMATION = 0x0400;
  private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  private const uint TH32CS_SNAPPROCESS = 0x00000002;
  private const uint INFINITE = 0xFFFFFFFF;
  private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

  [StructLayout(LayoutKind.Sequential)]
  private struct PROCESS_BASIC_INFORMATION {
    public IntPtr ExitStatus;
    public IntPtr PebBaseAddress;
    public IntPtr AffinityMask;
    public IntPtr BasePriority;
    public IntPtr UniqueProcessId;
    public IntPtr InheritedFromUniqueProcessId;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct IO_COUNTERS {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct PROCESSENTRY32W {
    public uint dwSize;
    public uint cntUsage;
    public uint th32ProcessID;
    public IntPtr th32DefaultHeapID;
    public uint th32ModuleID;
    public uint cntThreads;
    public uint th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
    public string szExeFile;
  }

  [DllImport("ntdll.dll")]
  private static extern int NtQueryInformationProcess(
    IntPtr hProcess, int pic, ref PROCESS_BASIC_INFORMATION pbi, int cb, out int retLen);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr h);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetProcessTimes(
    IntPtr hProcess, out long creationTime, out long exitTime, out long kernelTime, out long userTime);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetInformationJobObject(
    IntPtr hJob, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int cb);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool ReadProcessMemory(
    IntPtr hProcess, IntPtr baseAddr, byte[] buf, int size, out IntPtr read);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool IsWow64Process(IntPtr hProcess, out bool wow64Process);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool Process32FirstW(IntPtr hSnapshot, ref PROCESSENTRY32W lppe);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool Process32NextW(IntPtr hSnapshot, ref PROCESSENTRY32W lppe);

  private static int RunCage(int workerPid) {
    IntPtr hWorker = OpenProcess(
      SYNCHRONIZE | PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
      false,
      workerPid);
    if (hWorker == IntPtr.Zero) {
      Console.Error.WriteLine("OpenProcess failed: " + Marshal.GetLastWin32Error());
      return 2;
    }
    long cTime, eTime, kTime, uTime;
    if (!GetProcessTimes(hWorker, out cTime, out eTime, out kTime, out uTime) || eTime != 0) {
      CloseHandle(hWorker);
      Console.Error.WriteLine("Worker already exited");
      return 2;
    }
    IntPtr hJob = CreateJobObjectW(IntPtr.Zero, null);
    if (hJob == IntPtr.Zero) {
      int err = Marshal.GetLastWin32Error();
      CloseHandle(hWorker);
      Console.Error.WriteLine("CreateJobObjectW failed: " + err);
      return 3;
    }
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(hJob, 9, ref info, Marshal.SizeOf(info))) {
      int err = Marshal.GetLastWin32Error();
      CloseHandle(hJob);
      CloseHandle(hWorker);
      Console.Error.WriteLine("SetInformationJobObject failed: " + err);
      return 4;
    }
    if (!AssignProcessToJobObject(hJob, hWorker)) {
      int err = Marshal.GetLastWin32Error();
      CloseHandle(hJob);
      CloseHandle(hWorker);
      Console.Error.WriteLine("AssignProcessToJobObject failed: " + err);
      return 5;
    }
    Console.Out.WriteLine("READY");
    Console.Out.Flush();
    WaitForSingleObject(hWorker, INFINITE);
    CloseHandle(hJob);
    CloseHandle(hWorker);
    return 0;
  }

  private static int RunProcInfo(int pid) {
    IntPtr hProc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (hProc == IntPtr.Zero) return 1;
    try {
      long createTime, exitTime, kernelTime, userTime;
      if (!GetProcessTimes(hProc, out createTime, out exitTime, out kernelTime, out userTime)) return 1;
      if (createTime <= 0 || exitTime != 0) return 1;
      PROCESS_BASIC_INFORMATION pbi = new PROCESS_BASIC_INFORMATION();
      int retLen;
      long ppid = 0;
      if (NtQueryInformationProcess(hProc, 0, ref pbi, Marshal.SizeOf(pbi), out retLen) == 0) {
        ppid = pbi.InheritedFromUniqueProcessId.ToInt64();
      }
      Console.Out.WriteLine(createTime.ToString() + "\t" + ppid.ToString());
      return 0;
    } finally {
      CloseHandle(hProc);
    }
  }

  private static void AddAncestors(int startPid, HashSet<int> excluded) {
    int cur = startPid;
    for (int depth = 0; depth < 16 && cur > 4; depth++) {
      excluded.Add(cur);
      IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, cur);
      if (h == IntPtr.Zero) break;
      try {
        PROCESS_BASIC_INFORMATION pbi = new PROCESS_BASIC_INFORMATION();
        int retLen;
        if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out retLen) != 0) break;
        int next = (int)pbi.InheritedFromUniqueProcessId.ToInt64();
        if (next <= 4 || excluded.Contains(next)) break;
        cur = next;
      } finally {
        CloseHandle(h);
      }
    }
  }

  private static bool ProcessMatchesMarkers(int pid, List<string> cmdMarkers, List<string> envExactLines) {
    IntPtr h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);
    if (h == IntPtr.Zero) return false;
    try {
      long cTime, eTime, kTime, uTime;
      if (!GetProcessTimes(h, out cTime, out eTime, out kTime, out uTime) || eTime != 0) return false;
      if (IntPtr.Size == 8) {
        bool wow64;
        if (IsWow64Process(h, out wow64) && wow64) return false;
      } else {
        return false;
      }
      PROCESS_BASIC_INFORMATION pbi = new PROCESS_BASIC_INFORMATION();
      int retLen;
      if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out retLen) != 0 || pbi.PebBaseAddress == IntPtr.Zero) {
        return false;
      }
      byte[] ptrBuf = new byte[8];
      IntPtr read;
      if (!ReadProcessMemory(h, IntPtr.Add(pbi.PebBaseAddress, 0x20), ptrBuf, 8, out read)) return false;
      long procParamsAddr = BitConverter.ToInt64(ptrBuf, 0);
      if (procParamsAddr == 0) return false;
      IntPtr procParams = new IntPtr(procParamsAddr);

      byte[] usBuf = new byte[16];
      if (cmdMarkers.Count > 0 && ReadProcessMemory(h, IntPtr.Add(procParams, 0x70), usBuf, 16, out read)) {
        ushort cmdLen = BitConverter.ToUInt16(usBuf, 0);
        long cmdAddr = BitConverter.ToInt64(usBuf, 8);
        if (cmdLen > 0 && cmdAddr != 0) {
          byte[] cmdBytes = new byte[cmdLen];
          if (ReadProcessMemory(h, new IntPtr(cmdAddr), cmdBytes, cmdLen, out read) && (int)read > 0) {
            string cmdText = Encoding.Unicode.GetString(cmdBytes, 0, (int)read);
            for (int i = 0; i < cmdMarkers.Count; i++) {
              if (cmdText.IndexOf(cmdMarkers[i], StringComparison.OrdinalIgnoreCase) >= 0) return true;
            }
          }
        }
      }

      if (envExactLines.Count > 0 && ReadProcessMemory(h, IntPtr.Add(procParams, 0x80), ptrBuf, 8, out read)) {
        long envAddr = BitConverter.ToInt64(ptrBuf, 0);
        if (envAddr != 0) {
          StringBuilder curEntry = new StringBuilder(256);
          byte[] pageBuf = new byte[4096];
          int offset = 0;
          bool prevNull = false;
          bool done = false;
          while (!done && offset < 262144) {
            ulong cur = (ulong)envAddr + (ulong)offset;
            int step = 4096 - (int)(cur & 0xFFFUL);
            if (!ReadProcessMemory(h, new IntPtr((long)cur), pageBuf, step, out read)) break;
            int n = (int)read & ~1;
            if (n <= 0) break;
            for (int i = 0; i < n; i += 2) {
              char ch = (char)(pageBuf[i] | (pageBuf[i + 1] << 8));
              if (ch == '\0') {
                if (prevNull) { done = true; break; }
                prevNull = true;
                if (curEntry.Length > 18) {
                  string entryStr = curEntry.ToString();
                  for (int m = 0; m < envExactLines.Count; m++) {
                    if (string.Equals(entryStr, envExactLines[m], StringComparison.OrdinalIgnoreCase)) return true;
                  }
                }
                curEntry.Length = 0;
              } else {
                prevNull = false;
                curEntry.Append(ch);
              }
            }
            offset += n;
          }
        }
      }
      return false;
    } catch {
      return false;
    } finally {
      CloseHandle(h);
    }
  }

  private static int RunFindOrphans(string excludeCsv) {
    Console.InputEncoding = Encoding.UTF8;
    Console.OutputEncoding = Encoding.UTF8;
    HashSet<int> excluded = new HashSet<int>();
    AddAncestors(System.Diagnostics.Process.GetCurrentProcess().Id, excluded);
    if (!string.IsNullOrEmpty(excludeCsv)) {
      foreach (string part in excludeCsv.Split(',')) {
        int val;
        if (int.TryParse(part.Trim(), out val) && val > 0) AddAncestors(val, excluded);
      }
    }
    List<string> cmdMarkers = new List<string>();
    List<string> envExactLines = new List<string>();
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      string trimmed = line.Trim();
      if (trimmed.StartsWith("CMD:", StringComparison.Ordinal)) {
        string v = trimmed.Substring(4);
        if (v.Length > 8) cmdMarkers.Add(v);
      } else if (trimmed.StartsWith("ENV:", StringComparison.Ordinal)) {
        string v = trimmed.Substring(4);
        if (v.Length > 18) envExactLines.Add(v);
      } else if (trimmed.Length > 8) {
        cmdMarkers.Add(trimmed);
      }
    }
    if (cmdMarkers.Count == 0 && envExactLines.Count == 0) return 0;

    IntPtr snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE || snap == IntPtr.Zero) return 1;
    try {
      PROCESSENTRY32W entry = new PROCESSENTRY32W();
      entry.dwSize = (uint)Marshal.SizeOf(entry);
      if (!Process32FirstW(snap, ref entry)) return 0;
      do {
        int pid = (int)entry.th32ProcessID;
        if (pid <= 4 || excluded.Contains(pid)) continue;
        if (ProcessMatchesMarkers(pid, cmdMarkers, envExactLines)) {
          Console.Out.WriteLine(pid.ToString());
        }
      } while (Process32NextW(snap, ref entry));
      return 0;
    } finally {
      CloseHandle(snap);
    }
  }

  public static int Main(string[] args) {
    if (args.Length < 1) return 2;
    string mode = args[0];
    if (mode == "cage" && args.Length >= 2) {
      int pid;
      return int.TryParse(args[1], out pid) && pid > 0 ? RunCage(pid) : 2;
    }
    if (mode == "proc-info" && args.Length >= 2) {
      int pid;
      return int.TryParse(args[1], out pid) && pid > 0 ? RunProcInfo(pid) : 2;
    }
    if (mode == "find-orphans") {
      return RunFindOrphans(args.Length >= 2 ? args[1] : "");
    }
    return 2;
  }
}
`;

const HELPER_HASH = createHash('sha256').update(CSHARP_HELPER_SOURCE).digest('hex').slice(0, 16);

let helperPromise = null;
let helperBinaryPath = null;
let activeCagePromise = null;
let activeCagePid = null;

export function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function isRegularFile(filePath) {
  try {
    return (await lstat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function findCscCompiler() {
  const windir = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const candidates = [
    path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  for (const candidate of candidates) {
    if (await isRegularFile(candidate)) return candidate;
  }
  return null;
}

export async function ensureWin32Helper() {
  if (process.platform !== 'win32') return null;
  if (helperBinaryPath && await isRegularFile(helperBinaryPath)) return helperBinaryPath;
  if (helperPromise) return helperPromise;

  helperPromise = (async () => {
    const cacheDir = path.join(tmpdir(), 'futureaide-process-cage');
    const targetExe = path.join(cacheDir, `cage-helper-${HELPER_HASH}.exe`);
    if (await isRegularFile(targetExe)) {
      helperBinaryPath = targetExe;
      return targetExe;
    }
    const csc = await findCscCompiler();
    if (!csc) return null;

    await mkdir(cacheDir, { recursive: true });
    const nonce = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
    const tempCs = path.join(cacheDir, `cage-helper-${nonce}.cs`);
    const tempExe = path.join(cacheDir, `cage-helper-${nonce}.exe`);
    try {
      await writeFile(tempCs, CSHARP_HELPER_SOURCE, 'utf8');
      await execFileAsync(csc, ['/nologo', '/optimize+', '/target:exe', `/out:${tempExe}`, tempCs], {
        windowsHide: true,
        timeout: HELPER_TIMEOUT_MS,
      });
      try {
        await rename(tempExe, targetExe);
      } catch {
        if (!(await isRegularFile(targetExe))) throw new Error('Failed to publish cage-helper binary.');
      }
      helperBinaryPath = targetExe;
      return targetExe;
    } catch {
      return null;
    } finally {
      await unlink(tempCs).catch(() => undefined);
      await unlink(tempExe).catch(() => undefined);
    }
  })();

  try {
    return await helperPromise;
  } finally {
    helperPromise = null;
  }
}

/**
 * Bind the current Worker process to a Windows Job Object configured with
 * JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (0x2000). A lightweight windowless holder
 * owns the Job handle and waits on the Worker's kernel process handle: the
 * instant the Worker exits normally, throws, or is killed, the holder closes
 * the Job handle and the Windows kernel terminates every descendant process
 * (including grandchildren orphaned by an exited intermediate cmd.exe).
 */
export async function attachCurrentProcessToJobCage() {
  if (process.platform !== 'win32') {
    return { ok: true, supported: false };
  }
  if (activeCagePid && isProcessAlive(activeCagePid)) {
    return { ok: true, supported: true, cagePid: activeCagePid };
  }
  if (activeCagePromise) return activeCagePromise;

  activeCagePromise = (async () => {
    const helper = await ensureWin32Helper();
    if (helper) {
      return await new Promise(resolve => {
        let settled = false;
        let stdoutText = '';
        let stderrText = '';
        const finish = value => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { child.stdout?.destroy(); } catch { /* ignore */ }
          try { child.stderr?.destroy(); } catch { /* ignore */ }
          try { child.unref(); } catch { /* ignore */ }
          resolve(value);
        };
        const child = spawn(helper, ['cage', String(process.pid)], {
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
        const timer = setTimeout(() => {
          try { child.kill(); } catch { /* ignore */ }
          finish({ ok: false, supported: true, error: 'Timed out waiting for Job Object cage holder.' });
        }, CAGE_READY_TIMEOUT_MS);
        timer.unref?.();

        child.stdout.on('data', chunk => {
          stdoutText += String(chunk);
          if (stdoutText.includes('READY')) {
            activeCagePid = child.pid ?? null;
            finish({ ok: true, supported: true, cagePid: activeCagePid });
          }
        });
        child.stderr.on('data', chunk => {
          stderrText += String(chunk);
        });
        child.once('error', error => {
          finish({ ok: false, supported: true, error: String(error?.message ?? error) });
        });
        child.once('exit', code => {
          finish({
            ok: false,
            supported: true,
            error: `Job cage holder exited early (code ${code ?? 'unknown'}): ${stderrText.trim().slice(0, 240)}`,
          });
        });
      });
    }

    // Fallback when csc.exe is unavailable: PowerShell P/Invoke Job Object holder.
    const psScript = [
      '$ErrorActionPreference = "Stop"',
      'Add-Type -TypeDefinition @"',
      'using System; using System.Runtime.InteropServices;',
      'public static class FaJob {',
      '  [StructLayout(LayoutKind.Sequential)] public struct BL { public long a,b; public uint LimitFlags; public UIntPtr c,d; public uint e; public UIntPtr f; public uint g,h; }',
      '  [StructLayout(LayoutKind.Sequential)] public struct IO { public ulong a,b,c,d,e,f; }',
      '  [StructLayout(LayoutKind.Sequential)] public struct EL { public BL Basic; public IO Io; public UIntPtr a,b,c,d; }',
      '  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint a, bool b, int pid);',
      '  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr a, string n);',
      '  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr j, int c, ref EL i, int s);',
      '  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);',
      '  [DllImport("kernel32.dll", SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr h, uint ms);',
      '  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);',
      '}',
      '"@',
      `$hProc = [FaJob]::OpenProcess(0x00100101, $false, ${process.pid})`,
      '$hJob = [FaJob]::CreateJobObject([IntPtr]::Zero, $null)',
      '$el = New-Object FaJob+EL; $el.Basic.LimitFlags = 0x2000',
      'if (-not [FaJob]::SetInformationJobObject($hJob, 9, [ref]$el, [Runtime.InteropServices.Marshal]::SizeOf($el))) { exit 4 }',
      'if (-not [FaJob]::AssignProcessToJobObject($hJob, $hProc)) { exit 5 }',
      '[Console]::Out.WriteLine("READY"); [Console]::Out.Flush()',
      '[void][FaJob]::WaitForSingleObject($hProc, 0xFFFFFFFF)',
      '[void][FaJob]::CloseHandle($hJob); [void][FaJob]::CloseHandle($hProc)',
    ].join('\n');

    return await new Promise(resolve => {
      let settled = false;
      let stdoutText = '';
      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { child.stdout?.destroy(); } catch { /* ignore */ }
        try { child.unref(); } catch { /* ignore */ }
        resolve(value);
      };
      const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', psScript], {
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        finish({ ok: false, supported: true, error: 'Timed out starting fallback Job cage.' });
      }, CAGE_READY_TIMEOUT_MS);
      timer.unref?.();
      child.stdout.on('data', chunk => {
        stdoutText += String(chunk);
        if (stdoutText.includes('READY')) {
          activeCagePid = child.pid ?? null;
          finish({ ok: true, supported: true, cagePid: activeCagePid });
        }
      });
      child.once('error', err => finish({ ok: false, supported: true, error: String(err?.message ?? err) }));
      child.once('exit', code => finish({ ok: false, supported: true, error: `Fallback Job cage exited (${code})` }));
    });
  })();

  try {
    return await activeCagePromise;
  } finally {
    activeCagePromise = null;
  }
}

/**
 * Fast Win32 process startTime (UTC FileTime 100ns ticks, identical to
 * StartTime.ToFileTimeUtc()) and parentProcessId query (~15ms, zero PowerShell).
 */
export async function queryWin32ProcessInfo(pid) {
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  if (!isProcessAlive(pid)) return null;
  const helper = await ensureWin32Helper();
  if (!helper) return null;
  try {
    const { stdout } = await execFileAsync(helper, ['proc-info', String(pid)], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: HELPER_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
    });
    const trimmed = String(stdout ?? '').trim();
    const tab = trimmed.indexOf('\t');
    if (tab <= 0) return null;
    const startTime = trimmed.slice(0, tab).trim();
    const ppidRaw = Number.parseInt(trimmed.slice(tab + 1).trim(), 10);
    if (!/^\d+$/.test(startTime)) return null;
    return {
      startTime,
      parentPid: Number.isSafeInteger(ppidRaw) && ppidRaw > 0 ? ppidRaw : null,
    };
  } catch {
    return null;
  }
}

async function killSingleTree(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  if (!isProcessAlive(pid)) return false;
  if (process.platform !== 'win32') {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* not a process group leader */ }
    try { process.kill(pid, 'SIGKILL'); return true; }
    catch (error) { return error?.code !== 'ESRCH'; }
  }
  const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  const code = await new Promise(resolve => {
    child.once('exit', value => resolve(value ?? null));
    child.once('error', () => resolve(-1));
  });
  return code === 0 || !isProcessAlive(pid);
}

function buildSearchSpec({ turnDir, runId, sessionId }) {
  const rawCmd = [];
  const rawEnv = [];
  if (typeof turnDir === 'string' && turnDir.trim().length > 8) {
    const trimmed = turnDir.trim();
    const resolved = path.resolve(trimmed);
    rawCmd.push(trimmed, resolved, resolved.replace(/\\/g, '/'), resolved.replace(/\\/g, '\\\\'));
    rawEnv.push(`FUTUREAIDE_TURN_DIR=${trimmed}`, `FUTUREAIDE_TURN_DIR=${resolved}`);
  }
  if (typeof runId === 'string' && runId.trim().length > 8) {
    const trimmed = runId.trim();
    rawCmd.push(trimmed);
    rawEnv.push(`FUTUREAIDE_RUN_ID=${trimmed}`);
  }
  // Note: sessionId can be shared across sequential turns of the same persistent session;
  // only match sessionId when neither turnDir nor runId was given, so finishing turn 1
  // never kills a sibling turn or shared session watcher.
  if (!rawCmd.length && typeof sessionId === 'string' && sessionId.trim().length > 8) {
    rawCmd.push(sessionId.trim());
  }
  const dedup = list => {
    const seen = new Set();
    const out = [];
    for (const item of list) {
      if (typeof item !== 'string' || item.length <= 8) continue;
      const key = item.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  };
  return { cmdMarkers: dedup(rawCmd), envExactLines: dedup(rawEnv) };
}

async function findOrphansWin32({ cmdMarkers, envExactLines }, excludePids) {
  if (!cmdMarkers.length && !envExactLines.length) return [];
  const stdinPayload = [
    ...cmdMarkers.map(m => `CMD:${m}`),
    ...envExactLines.map(e => `ENV:${e}`),
  ].join('\n') + '\n';
  const helper = await ensureWin32Helper();
  if (helper) {
    try {
      const excludeArg = [...excludePids].join(',');
      const stdout = await new Promise((resolve, reject) => {
        const child = spawn(helper, ['find-orphans', excludeArg], {
          stdio: ['pipe', 'pipe', 'ignore'],
          windowsHide: true,
        });
        let out = '';
        const timer = setTimeout(() => {
          try { child.kill(); } catch { /* ignore */ }
          reject(new Error('find-orphans timeout'));
        }, HELPER_TIMEOUT_MS);
        timer.unref?.();
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => { out += chunk; });
        child.once('error', err => { clearTimeout(timer); reject(err); });
        child.once('close', () => { clearTimeout(timer); resolve(out); });
        child.stdin.end(stdinPayload, 'utf8');
      });
      return String(stdout ?? '')
        .split(/\r?\n/)
        .map(line => Number.parseInt(line.trim(), 10))
        .filter(pid => Number.isSafeInteger(pid) && pid > 0 && !excludePids.has(pid));
    } catch {
      // Fall through to CIM command-line scan if helper fails.
    }
  }

  if (!cmdMarkers.length) return [];
  // Fallback CIM scan by CommandLine when csc.exe helper is unavailable.
  const script = [
    '[Console]::InputEncoding = [System.Text.Encoding]::UTF8',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$markers = @([Console]::In.ReadToEnd() -split "\\r?\\n" | Where-Object { $_.Length -gt 8 })',
    'if ($markers.Count -eq 0) { exit 0 }',
    'foreach ($p in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {',
    '  $cmd = [string]$p.CommandLine',
    '  if (-not $cmd) { continue }',
    '  foreach ($m in $markers) {',
    '    if ($cmd.IndexOf($m, [StringComparison]::OrdinalIgnoreCase) -ge 0) { [Console]::Out.WriteLine($p.ProcessId); break }',
    '  }',
    '}',
  ].join('\n');
  try {
    const stdout = await new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
      let out = '';
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        reject(new Error('CIM orphan scan timeout'));
      }, HELPER_TIMEOUT_MS);
      timer.unref?.();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { out += chunk; });
      child.once('error', err => { clearTimeout(timer); reject(err); });
      child.once('close', () => { clearTimeout(timer); resolve(out); });
      child.stdin.end(cmdMarkers.join('\n') + '\n', 'utf8');
    });
    return String(stdout ?? '')
      .split(/\r?\n/)
      .map(line => Number.parseInt(line.trim(), 10))
      .filter(pid => Number.isSafeInteger(pid) && pid > 0 && !excludePids.has(pid));
  } catch {
    return [];
  }
}

async function findOrphansPosix({ cmdMarkers, envExactLines }, excludePids) {
  if (!cmdMarkers.length && !envExactLines.length) return [];
  const lowerCmd = cmdMarkers.map(m => m.toLowerCase());
  const lowerEnv = envExactLines.map(e => e.toLowerCase());
  const matched = [];
  let entries = [];
  try { entries = await readdir('/proc'); } catch { return []; }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number.parseInt(name, 10);
    if (!Number.isSafeInteger(pid) || pid <= 1 || excludePids.has(pid)) continue;
    try {
      const cmd = (await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')).split('\0').join(' ').toLowerCase();
      if (lowerCmd.some(m => cmd.includes(m))) { matched.push(pid); continue; }
      const envEntries = (await readFile(`/proc/${pid}/environ`, 'utf8').catch(() => '')).split('\0').map(s => s.toLowerCase());
      if (lowerEnv.some(e => envEntries.includes(e))) matched.push(pid);
    } catch { /* process exited */ }
  }
  return matched;
}

/**
 * Terminate recorded PIDs (`taskkill /PID <pid> /T /F`) and sweep any surviving
 * orphan descendants whose command line or environment carries `turnDir`, `runId`,
 * or `sessionId` (catching grandchildren detached when an intermediate `cmd.exe`
 * exited early).
 */
export async function killProcessCage({ pids = [], turnDir, runId, sessionId } = {}) {
  const killed = new Set();
  const excluded = new Set([
    process.pid,
    ...(Number.isSafeInteger(activeCagePid) && activeCagePid > 0 ? [activeCagePid] : []),
  ]);

  const directPids = [...new Set(
    (Array.isArray(pids) ? pids : [pids])
      .filter(pid => Number.isSafeInteger(pid) && pid > 0 && !excluded.has(pid)),
  )];

  for (const pid of directPids) {
    if (isProcessAlive(pid)) {
      await killSingleTree(pid);
      killed.add(pid);
    }
  }

  const searchSpec = buildSearchSpec({ turnDir, runId, sessionId });
  if (searchSpec.cmdMarkers.length || searchSpec.envExactLines.length) {
    for (let pass = 0; pass < 2; pass++) {
      const orphans = process.platform === 'win32'
        ? await findOrphansWin32(searchSpec, excluded)
        : await findOrphansPosix(searchSpec, excluded);
      if (!orphans.length) break;
      for (const pid of orphans) {
        if (isProcessAlive(pid)) {
          await killSingleTree(pid);
          killed.add(pid);
        }
      }
      if (pass === 0) await delay(40);
    }
  }

  const tracked = [...new Set([...directPids, ...killed])];
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline && tracked.some(pid => isProcessAlive(pid))) {
    await delay(40);
  }

  const remaining = tracked.filter(pid => isProcessAlive(pid));
  return {
    ok: remaining.length === 0,
    killed: [...killed],
  };
}
