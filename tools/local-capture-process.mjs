import {spawn, execFile} from 'node:child_process';
import path from 'node:path';
import {realpathSync} from 'node:fs';

const ownedChildren = new WeakMap();
const CLOSE_WAIT_MS = 5000;
const TREE_STOP_MS = 10000;

// Toolhelp/OpenProcess avoid taskkill's WMI dependency. Retained handles and
// creation times bind descendants even after their parent has been terminated.
const WINDOWS_TREE_STOP = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
try {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class CaptureOwnedTree {
  public static int Step=0, Error=0;
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct Entry { public uint size,usage,pid; public UIntPtr heap; public uint module,threads,parent; public int priority; public uint flags; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string exe; }
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32FirstW(IntPtr snapshot,ref Entry entry);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32NextW(IntPtr snapshot,ref Entry entry);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long created,out long exited,out long kernel,out long user);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageNameW(IntPtr process,uint flags,StringBuilder name,ref int length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  sealed class Owned { public uint pid; public IntPtr handle; public long created; }
  static void Check(bool value) { if(!value){Error=Marshal.GetLastWin32Error();throw new InvalidOperationException("Unconfirmed owned tree");} }
  static long Created(IntPtr handle,out long exited) { long created,kernel,user; Check(GetProcessTimes(handle,out created,out exited,out kernel,out user)); return created; }
  static bool Alive(Owned process) { uint state=WaitForSingleObject(process.handle,0); Check(state==0||state==258); return state==258; }
  static Dictionary<uint,Entry> Snapshot() {
    IntPtr handle=CreateToolhelp32Snapshot(2,0); Check(handle!=new IntPtr(-1));
    try {
      var rows=new Dictionary<uint,Entry>(); Entry entry=new Entry(); entry.size=(uint)Marshal.SizeOf(typeof(Entry));
      Check(Process32FirstW(handle,ref entry));
      do { rows[entry.pid]=entry; } while(Process32NextW(handle,ref entry));
      Check(Marshal.GetLastWin32Error()==18); return rows;
    } finally { CloseHandle(handle); }
  }
  static Owned Open(uint pid) {
    IntPtr handle=OpenProcess(0x101001,false,pid); Check(handle!=IntPtr.Zero);
    try { long exited; return new Owned {pid=pid,handle=handle,created=Created(handle,out exited)}; }
    catch { CloseHandle(handle); throw; }
  }
  public static void Stop(uint pid,uint parent,long before,long after,string executable) {
    var owned=new Dictionary<uint,Owned>(); var watch=Stopwatch.StartNew();
    try {
      Step=1;var rows=Snapshot(); Entry rootRow; Check(rows.TryGetValue(pid,out rootRow)&&rootRow.parent==parent);
      Step=2;
      var root=Open(pid); owned.Add(pid,root);
      long milliseconds=(root.created-116444736000000000L)/10000;
      Step=3;Check(milliseconds>=before&&milliseconds<=after&&Alive(root));
      var image=new StringBuilder(32768); int length=image.Capacity;
      Step=4;Check(QueryFullProcessImageNameW(root.handle,0,image,ref length));
      Check(String.Equals(Path.GetFullPath(image.ToString()),Path.GetFullPath(executable),StringComparison.OrdinalIgnoreCase));
      for(int pass=0;pass<64&&watch.ElapsedMilliseconds<7000;pass++) {
        Step=5;rows=Snapshot(); bool added;
        do {
          added=false;
          foreach(var row in rows.Values) {
            Owned ancestor; if(owned.ContainsKey(row.pid)||!owned.TryGetValue(row.parent,out ancestor))continue;
            Check(owned.Count<512);
            Step=6;var child=Open(row.pid); owned.Add(row.pid,child);
            long exit; Created(ancestor.handle,out exit);
            Step=7;Check(child.created>=ancestor.created&&(exit==0||child.created<=exit));
            added=true;
          }
        } while(added);
        bool stopped=true;
        Step=8;foreach(var process in owned.Values) if(Alive(process)) {
          stopped=false;
          Step=9;if(!TerminateProcess(process.handle,1)) {
            // A parent's Job Object may already be terminating this child.
            // Access denied is not success: wait on the same owned handle.
            int error=Marshal.GetLastWin32Error();
            Check(error==5&&WaitForSingleObject(process.handle,(uint)Math.Max(0,7000-watch.ElapsedMilliseconds))==0);
          }
        }
        // A fresh snapshot after every known parent exited catches children
        // created during the preceding snapshot/termination pass.
        if(stopped){Step=100;return;}
        Thread.Sleep(10);
      }
      throw new InvalidOperationException("Owned tree stop deadline");
    } finally { foreach(var process in owned.Values)CloseHandle(process.handle); }
  }
}
'@
[CaptureOwnedTree]::Stop([uint32]$env:CAPTURE_STOP_PID,[uint32]$env:CAPTURE_STOP_PARENT,[long]$env:CAPTURE_STOP_BEFORE,[long]$env:CAPTURE_STOP_AFTER,$env:CAPTURE_STOP_EXE)
[Console]::Out.Write('CAPTURE_TREE_STOPPED')
exit 0
} catch { [Console]::Error.Write('CAPTURE_TREE_UNCONFIRMED:'+ [CaptureOwnedTree]::Step + ':' + [CaptureOwnedTree]::Error); exit 1 }
`;

export function terminateOwnedCaptureTree(child, {isRunning}) {
  const identity=ownedChildren.get(child);
  if (!identity || !isRunning() || child.pid!==identity.pid ||
      !Number.isSafeInteger(child.pid) || child.pid <= 0) return;
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    return;
  }
  const systemRoot=process.env.SystemRoot || 'C:\\Windows';
  const executable = path.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  return new Promise((resolve, reject) => {
    const bootstrap=Buffer.from('& ([scriptblock]::Create([Console]::In.ReadToEnd()))','utf16le').toString('base64');
    const helper=execFile(executable, ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',bootstrap],
      {windowsHide:true,timeout:TREE_STOP_MS,maxBuffer:4096,env:{SystemRoot:systemRoot,WINDIR:systemRoot,
        TEMP:process.env.TEMP,TMP:process.env.TMP,PATH:path.join(systemRoot,'System32'),
        CAPTURE_STOP_PID:String(identity.pid),CAPTURE_STOP_PARENT:String(identity.parent),
        CAPTURE_STOP_BEFORE:String(identity.before),CAPTURE_STOP_AFTER:String(identity.after),CAPTURE_STOP_EXE:identity.executable}}, (error,stdout,stderr) => {
        if (error || stdout!=='CAPTURE_TREE_STOPPED') {
          const failure=new Error('Owned capture tree termination unconfirmed');
          failure.termination={code:Number.isInteger(error?.code)?error.code:/^[A-Z_]{1,40}$/.test(error?.code||'')?error.code:'UNCONFIRMED',
            marker:/^CAPTURE_TREE_UNCONFIRMED:\d+:\d+$/.test(stderr||'')?stderr:'invalid-or-missing-confirmation'};
          reject(failure);
        }
        else resolve();
      });
    helper.stdin.on('error',()=>{});
    helper.stdin.end(WINDOWS_TREE_STOP);
  });
}

/**
 * Spawn one owned capture child. options.stdio must be an array containing one
 * 'ipc' entry (for example ['ignore', logFd, logFd, 'ipc']). No shell is used.
 * At timeout send {type:'abort', reason:'timeout'}, then allow graceMs (10s by
 * default) for the worker's finally blocks before terminating its owned tree.
 * Resolve {status: exitCode, signal, timedOut}; callers MUST reject timedOut or
 * status !== 0, including a cooperative late exit with status 0.
 * recoverAfterTimeout(result) runs once, only after close and successful forced
 * termination if needed. Spawn, IPC configuration, termination, missing close,
 * and recovery errors reject. An unconfirmed close never permits recovery.
 * spawnImpl and killTree(child, {isRunning}) are trusted test/caller adapters.
 */
export function runBoundedCaptureProcess({file, args = [], options = {}, timeoutMs,
  graceMs = 10000, spawnImpl = spawn, killTree = terminateOwnedCaptureTree,
  recoverAfterTimeout} = {}) {
  return new Promise((resolve, reject) => {
    if (typeof file !== 'string' || !file || !Array.isArray(args) ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647 ||
        !Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 2147483647 ||
        typeof spawnImpl !== 'function' || typeof killTree !== 'function' ||
        (recoverAfterTimeout !== undefined && typeof recoverAfterTimeout !== 'function')) {
      reject(new TypeError('Invalid bounded capture process configuration')); return;
    }
    const stdio = options.stdio ?? ['ignore', 'ignore', 'ignore', 'ipc'];
    if (!Array.isArray(stdio) || stdio.filter(value => value === 'ipc').length !== 1) {
      reject(new TypeError('Capture stdio requires exactly one IPC channel')); return;
    }
    // Native spawn timeouts/abort signals would bypass the cooperative grace period.
    const {timeout:ignoredTimeout, signal:ignoredSignal, killSignal:ignoredKillSignal,
      ...spawnOptions} = options;
    let executable=file;
    if(process.platform==='win32'&&killTree===terminateOwnedCaptureTree){
      try { executable=realpathSync(file); }
      catch(error){reject(error);return;}
    }
    let child;
    const before=Date.now();
    try {
      child = spawnImpl(file, args, {...spawnOptions, stdio, shell:false,
        windowsHide:true, detached:process.platform !== 'win32'});
    } catch (error) { reject(error); return; }
    ownedChildren.set(child,{pid:child.pid,parent:process.pid,before,after:Date.now(),executable});
    let exited = false, closed = false, settled = false, timedOut = false;
    let deadlineTimer, graceTimer, closeTimer, terminationTimer, termination;
    const running = () => !exited && !closed && !settled &&
      child.exitCode == null && child.signalCode == null;
    const cleanup = () => {
      clearTimeout(deadlineTimer); clearTimeout(graceTimer); clearTimeout(closeTimer); clearTimeout(terminationTimer);
      // Keep the exact spawned identity available for explicit owner cleanup
      // after a failed stop. Never turn an unconfirmed stop into recovery.
      if(exited||closed)ownedChildren.delete(child);
    };
    const fail = error => {
      if (settled) return;
      settled = true; cleanup(); reject(error);
    };
    const force = () => {
      if (!running()) return;
      const stop=Promise.resolve().then(() => {
        if (running()) return killTree(child, {isRunning:running});
      });
      termination=Promise.race([stop,new Promise((resolve,reject)=>{
        terminationTimer=setTimeout(()=>reject(new Error('Owned capture tree termination deadline exceeded')),TREE_STOP_MS);
      })]);
      termination.then(() => {
        clearTimeout(terminationTimer);
        if (!closed && !settled) {
          clearTimeout(closeTimer);
          closeTimer = setTimeout(() =>
            fail(new Error('Capture tree termination did not produce child close')), CLOSE_WAIT_MS);
        }
      }, fail);
    };
    child.once('error', fail);
    child.once('exit', () => {
      exited = true; clearTimeout(deadlineTimer); clearTimeout(graceTimer);
      if (!closed && !settled) closeTimer = setTimeout(() =>
        fail(new Error('Capture exited without closing its output handles')), CLOSE_WAIT_MS);
    });
    child.once('close', async (status, signal) => {
      closed = true; clearTimeout(deadlineTimer); clearTimeout(graceTimer); clearTimeout(closeTimer);
      if (settled) return;
      try {
        await termination;
        if (settled) return;
        const result = {status, signal:signal ?? null, timedOut};
        if (timedOut && recoverAfterTimeout) await recoverAfterTimeout(result);
        if (settled) return;
        settled = true; cleanup(); resolve(result);
      } catch (error) { fail(error); }
    });
    deadlineTimer = setTimeout(() => {
      if (!running()) return;
      timedOut = true;
      graceTimer = setTimeout(force, graceMs);
      if (child.connected && typeof child.send === 'function') {
        try { child.send({type:'abort', reason:'timeout'}, () => {}); }
        catch { /* A closed IPC channel still gets the bounded grace period. */ }
      }
    }, timeoutMs);
  });
}
