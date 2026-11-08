using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class CaptureOwnedTree {
  [ThreadStatic] public static int Step; [ThreadStatic] public static int Error;
  [StructLayout(LayoutKind.Sequential)] struct Basic {public IntPtr reserved,peb,r0,r1,pid,parent;}
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {public long processTime,jobTime;public uint flags;public UIntPtr minWorking,maxWorking;public uint active;public UIntPtr affinity;public uint priority,scheduling;}
  [StructLayout(LayoutKind.Sequential)] struct Io {public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes;}
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {public BasicLimits basic;public Io io;public UIntPtr processMemory,jobMemory,peakProcess,peakJob;}
  [StructLayout(LayoutKind.Sequential)] struct Accounting {public long user,kernel,periodUser,periodKernel;public uint faults,total,active,terminated;}
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr h,out long c,out long e,out long k,out long u);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h,int kind,out Basic b,int size,out int returned);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageNameW(IntPtr h,uint flags,StringBuilder name,ref int length);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr security,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref ExtendedLimits limits,int size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out Accounting info,int size,out int returned);
  [DllImport("kernel32.dll",EntryPoint="QueryInformationJobObject",SetLastError=true)] static extern bool QueryLimits(IntPtr job,int kind,out ExtendedLimits info,int size,out int returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool assigned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h,uint ms);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public sealed class Owned {public uint pid,parent;public IntPtr handle,job;public long created;}
  static void Check(bool ok){if(!ok){Error=Marshal.GetLastWin32Error();throw new InvalidOperationException("Unconfirmed owned job");}}
  static uint Parent(IntPtr h,uint pid){Basic b;int returned;Check(NtQueryInformationProcess(h,0,out b,Marshal.SizeOf(typeof(Basic)),out returned)==0);Check(b.pid.ToInt64()==pid);return checked((uint)b.parent.ToInt64());}
  static void Image(IntPtr h,string executable){var b=new StringBuilder(32768);int n=b.Capacity;Check(QueryFullProcessImageNameW(h,0,b,ref n));Check(String.Equals(Path.GetFullPath(b.ToString()),Path.GetFullPath(executable),StringComparison.OrdinalIgnoreCase));}
  static IntPtr NewJob(){var h=CreateJobObjectW(IntPtr.Zero,null);Check(h!=IntPtr.Zero);try{var limits=new ExtendedLimits();limits.basic.flags=0x2008;limits.basic.active=512;Check(SetInformationJobObject(h,9,ref limits,Marshal.SizeOf(typeof(ExtendedLimits))));ExtendedLimits actual;int returned;Check(QueryLimits(h,9,out actual,Marshal.SizeOf(typeof(ExtendedLimits)),out returned));Check(actual.basic.flags==0x2008&&actual.basic.active==512);return h;}catch{CloseHandle(h);throw;}}
  public static Owned Register(uint pid,uint parent,long before,long after,string executable){
    Step=1;Error=0;Check(pid!=parent&&before>0&&after>=before);var root=new Owned{pid=pid};
    try{root.handle=OpenProcess(0x101501,false,pid);Check(root.handle!=IntPtr.Zero);root.parent=Parent(root.handle,pid);Step=2;Check(root.parent==parent);
      long exited,kernel,user;Check(GetProcessTimes(root.handle,out root.created,out exited,out kernel,out user));long ms=(root.created-116444736000000000L)/10000;
      Step=3;Check(ms>=before&&ms<=after&&WaitForSingleObject(root.handle,0)==258);Image(root.handle,executable);
      Step=4;root.job=NewJob();Check(AssignProcessToJobObject(root.job,root.handle));bool assigned;Check(IsProcessInJob(root.handle,root.job,out assigned)&&assigned);Check(!Empty(root));return root;
    }catch{Close(root);throw;}
  }
  public static void Initialize(uint parent,string executable){
    Check(Parent(Process.GetCurrentProcess().Handle,(uint)Process.GetCurrentProcess().Id)==parent);
    var owner=OpenProcess(0x101400,false,parent);Check(owner!=IntPtr.Zero);try{Check(WaitForSingleObject(owner,0)==258);Image(owner,executable);}finally{CloseHandle(owner);}
    var probe=NewJob();CloseHandle(probe);
  }
  public static bool Empty(Owned root){Accounting info;int returned;Check(QueryInformationJobObject(root.job,1,out info,Marshal.SizeOf(typeof(Accounting)),out returned));Check(info.active<=512);return info.active==0;}
  public static bool Drained(Owned root,int budget){var watch=Stopwatch.StartNew();while(!Empty(root)){if(watch.ElapsedMilliseconds>=budget)return false;Thread.Sleep(5);}return true;}
  public static void Stop(Owned root,int budget=7000){
    Step=5;Error=0;var watch=Stopwatch.StartNew();
    if(!Empty(root)&&!TerminateJobObject(root.job,1)){int code=Marshal.GetLastWin32Error();Check(code==5);}
    Step=6;for(;;){bool empty=Empty(root);uint state=WaitForSingleObject(root.handle,0);Check(state==0||state==258);
      if(empty&&state==0){Check(Empty(root));Step=100;return;}Check(watch.ElapsedMilliseconds<Math.Min(7000,budget));Thread.Sleep(10);}
  }
  public static void Close(Owned root){if(root.job!=IntPtr.Zero){CloseHandle(root.job);root.job=IntPtr.Zero;}if(root.handle!=IntPtr.Zero){CloseHandle(root.handle);root.handle=IntPtr.Zero;}}
}

public static class CaptureControl {
  [StructLayout(LayoutKind.Sequential)] struct Security {public int length;public IntPtr descriptor;[MarshalAs(UnmanagedType.Bool)] public bool inherit;}
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafePipeHandle CreateNamedPipeW(string name,uint mode,uint pipeMode,uint instances,uint outputSize,uint inputSize,uint timeout,ref Security security);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe,out uint pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle,out long created,out long exited,out long kernel,out long user);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static string Stage="NEW",RunStage="NEW";public static long Request;
  public static void Evidence(string reason){try{var file=Environment.GetEnvironmentVariable("CAPTURE_EXIT_EVIDENCE");if(!String.IsNullOrEmpty(file))File.WriteAllText(file,"reason="+reason+"\nstage="+Stage+"\nrun="+RunStage+"\nrequest="+Request+"\nexit="+Environment.ExitCode+"\n");}catch{}}
  static NamedPipeServerStream pipe;static StreamReader reader;static StreamWriter writer;static IntPtr owner;
  static void Check(bool ok){if(!ok)throw new InvalidOperationException("Control identity or transport unconfirmed");}
  static long Now(){return DateTime.UtcNow.Ticks/10000-62135596800000L;}
  public static void Open(uint parent,string token){
    long deadline;Check(long.TryParse(Environment.GetEnvironmentVariable("CAPTURE_SETUP_DEADLINE"),out deadline));
    Check(deadline>Now()&&deadline-Now()<=30000);
    owner=OpenProcess(0x101000,false,parent);Check(owner!=IntPtr.Zero);
    long born,exited,kernel,user,selfBorn;Check(GetProcessTimes(owner,out born,out exited,out kernel,out user));
    using(var self=Process.GetCurrentProcess()){Check(GetProcessTimes(self.Handle,out selfBorn,out exited,out kernel,out user));}
    Check(born<=selfBorn&&WaitForSingleObject(owner,0)==258);
    var acl=new PipeSecurity();acl.SetAccessRuleProtection(true,false);
    using(var identity=WindowsIdentity.GetCurrent()){
      Check(identity.User!=null);acl.SetOwner(identity.User);
      acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid,null),PipeAccessRights.FullControl,AccessControlType.Deny));
      acl.AddAccessRule(new PipeAccessRule(identity.User,PipeAccessRights.FullControl,AccessControlType.Allow));
    }
    byte[] descriptor=acl.GetSecurityDescriptorBinaryForm();var pinned=GCHandle.Alloc(descriptor,GCHandleType.Pinned);
    SafePipeHandle handle=null;
    try{
      var security=new Security{length=Marshal.SizeOf(typeof(Security)),descriptor=pinned.AddrOfPinnedObject(),inherit=false};
      // Overlapped I/O, first-instance-only, one instance, and kernel rejection of remote clients.
      handle=CreateNamedPipeW(@"\\.\pipe\polytrack-capture-"+parent+"-"+token,3u|(uint)PipeOptions.Asynchronous|0x80000u,8u,1,4096,4096,0,ref security);
      Check(handle!=null&&!handle.IsInvalid);
      pipe=new NamedPipeServerStream(PipeDirection.InOut,true,false,handle);handle=null;
    }finally{pinned.Free();if(handle!=null)handle.Dispose();}
    Console.Out.WriteLine("PIPE_LISTENING "+token+" "+parent+" "+Process.GetCurrentProcess().Id);Console.Out.Flush();
    var pending=pipe.BeginWaitForConnection(null,null);
    using(var wait=pending.AsyncWaitHandle){
      while(!wait.WaitOne((int)Math.Max(1,Math.Min(100,deadline-Now()))))Check(Now()<deadline&&WaitForSingleObject(owner,0)==258);
      Check(Now()<deadline&&WaitForSingleObject(owner,0)==258);pipe.EndWaitForConnection(pending);
    }
    uint client;Check(GetNamedPipeClientProcessId(pipe.SafePipeHandle,out client)&&client==parent&&WaitForSingleObject(owner,0)==258);
    reader=new StreamReader(pipe,Encoding.ASCII,false,256,true);writer=new StreamWriter(pipe,Encoding.ASCII,256,true);writer.NewLine="\n";writer.AutoFlush=true;
  }
  public static int Read(){Stage="READ_WAIT";int value=reader.Read();Stage=value<0?"READ_EOF":"READ_BYTE";return value;}
  public static void Write(string value){Stage="WRITE";writer.WriteLine(value);writer.Flush();Stage="WRITE_DONE";}
  public static void Close(){try{if(writer!=null)writer.Dispose();if(reader!=null)reader.Dispose();}finally{try{if(pipe!=null)pipe.Dispose();}finally{if(owner!=IntPtr.Zero){CloseHandle(owner);owner=IntPtr.Zero;}}}}
}

public static class CaptureTreeBroker {
  sealed class Job { public long id,releaseId;public CaptureOwnedTree.Owned root;public bool stopping,release,dirty; }
  static readonly object gate=new object(),output=new object();
  static readonly Dictionary<long,Job> jobs=new Dictionary<long,Job>();
  static int active;static bool closing,cleanupFailed;static string token,runtime;static uint parent;static long lastId;
  static void Write(string text) { lock(output){CaptureControl.Write(text);} }
  static void Phase(long id,int step){Write("PHASE "+token+" "+id+" "+step);}
  static string ReadLine() {var b=new StringBuilder();for(;;){int c=CaptureControl.Read();if(c<0){if(b.Length!=0)throw new InvalidOperationException();return null;}if(c==10)return b.ToString();if(c<32||c>126||b.Length>=256)throw new InvalidOperationException();b.Append((char)c);} }
  static long Number(string text) {if(text.Length<1||text.Length>16)throw new InvalidOperationException();foreach(char c in text)if(c<'0'||c>'9')throw new InvalidOperationException();long n=long.Parse(text);if(n<1||n>9007199254740991L)throw new InvalidOperationException();return n;}
  static void Queue(Job job,long request,bool report,int budget=7000) {
    lock(gate){if(job.stopping||active>=8)throw new InvalidOperationException();job.stopping=true;active++;}
    ThreadPool.QueueUserWorkItem(delegate {
      bool success=false;int step=0,error=0;
      try {CaptureOwnedTree.Stop(job.root,budget);success=true;}catch {step=CaptureOwnedTree.Step;error=CaptureOwnedTree.Error;lock(gate){cleanupFailed=true;}}
      try {if(report)Write((success?"STOPPED ":"FAILED ")+token+" "+request+(success?"":" "+step+" "+error));}catch {}
      lock(gate){job.stopping=false;active--;if(job.release){CaptureOwnedTree.Close(job.root);jobs.Remove(job.id);if(job.releaseId>0)try{Write((success?(job.dirty?"UNCLEAN ":"RELEASED "):"FAILED ")+token+" "+job.releaseId+(success?"":" "+step+" "+error));}catch{}}Monitor.PulseAll(gate);}
    });
  }
  static bool Shutdown() {
    closing=true;List<Job> remaining;lock(gate){remaining=new List<Job>(jobs.Values);}
    foreach(var job in remaining)if(!job.stopping)try{Queue(job,0,false);}catch{cleanupFailed=true;}
    var watch=Stopwatch.StartNew();lock(gate){while(active>0&&watch.ElapsedMilliseconds<8000)Monitor.Wait(gate,50);if(active>0)Environment.Exit(1);foreach(var job in jobs.Values){try{if(!CaptureOwnedTree.Empty(job.root))cleanupFailed=true;}catch{cleanupFailed=true;}CaptureOwnedTree.Close(job.root);}jobs.Clear();return !cleanupFailed;}
  }
  public static int Run(uint owner,string executable,string session) {
    parent=owner;runtime=executable;token=session;CaptureControl.RunStage="ENTER";AppDomain.CurrentDomain.ProcessExit+=delegate{CaptureControl.Evidence("PROCESS_EXIT");};
    try {
      if(token.Length!=64)throw new InvalidOperationException();foreach(char c in token)if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')))throw new InvalidOperationException();
      CaptureOwnedTree.Initialize(parent,runtime);CaptureControl.Open(parent,token);Write("READY "+token+" "+parent);
      for(;;){CaptureControl.RunStage="READ";string line=ReadLine();if(line==null){CaptureControl.RunStage="EOF";CaptureControl.Evidence("EOF");break;}CaptureControl.RunStage="PARSE";string[] p=line.Split(' ');if(p.Length<3||p[1]!=token)throw new InvalidOperationException();long id=Number(p[2]);if(id<=lastId||id>1000000)throw new InvalidOperationException();lastId=id;CaptureControl.Request=id;
        if(p[0]=="OWN"&&p.Length==6){uint pid=checked((uint)Number(p[3]));long before=Number(p[4]),after=Number(p[5]);try{lock(gate){if(closing||jobs.Count>=8)throw new InvalidOperationException();var root=CaptureOwnedTree.Register(pid,parent,before,after,runtime);jobs.Add(id,new Job{id=id,root=root});}Write("OWNED "+token+" "+id);}catch{Write("FAILED "+token+" "+id+" "+CaptureOwnedTree.Step+" "+CaptureOwnedTree.Error);}}
        else if(p[0]=="STOP"&&p.Length==5){int budget=checked((int)Number(p[4]));if(budget>10000)throw new InvalidOperationException();Job job;lock(gate){if(!jobs.TryGetValue(Number(p[3]),out job)||job.release)throw new InvalidOperationException();}Queue(job,id,true,budget);}
        else if(p[0]=="RELEASE"&&p.Length==5){int budget=checked((int)Number(p[4]));if(budget>5000)throw new InvalidOperationException();var watch=Stopwatch.StartNew();Phase(id,1);lock(gate){Job job;if(!jobs.TryGetValue(Number(p[3]),out job)||job.release)throw new InvalidOperationException();job.release=true;job.releaseId=id;Phase(id,2);bool drained=CaptureOwnedTree.Drained(job.root,Math.Min(250,budget/2));Phase(id,3);if(!drained){job.dirty=true;if(!job.stopping)Queue(job,0,false,Math.Max(1,budget-(int)watch.ElapsedMilliseconds));}else if(!job.stopping){Phase(id,4);CaptureOwnedTree.Close(job.root);jobs.Remove(job.id);Phase(id,5);Write("RELEASED "+token+" "+id);}}}
        else if(p[0]=="DISPOSE"&&p.Length==3){lock(gate){if(jobs.Count!=0||active!=0)throw new InvalidOperationException();}Write("BYE "+token+" "+id);return 0;}
        else throw new InvalidOperationException();
      }
      CaptureControl.RunStage="SHUTDOWN";return Shutdown()?0:1;
    }catch{try{Write("FATAL "+token);}catch{}Shutdown();return 1;}finally{CaptureControl.Evidence("RUN_FINALLY");CaptureControl.Close();CaptureControl.RunStage="RETURNED";}
  }
}

public static class Program { public static int Main(string[] args) { if(args.Length==1&&args[0]=="--self-test"){System.Console.WriteLine("fixed-broker-loaded");return 0;} return CaptureTreeBroker.Run(uint.Parse(System.Environment.GetEnvironmentVariable("CAPTURE_PARENT_PID")),System.Environment.GetEnvironmentVariable("CAPTURE_RUNTIME"),System.Environment.GetEnvironmentVariable("CAPTURE_SESSION")); } }
