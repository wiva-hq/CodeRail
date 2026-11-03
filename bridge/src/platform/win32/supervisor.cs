// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

// No Windows Service identity or elevation. Compiled as WinExe: no console flash.
class Supervisor {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO {
        public int cb; public string reserved, desktop, title;
        public int x,y,xSize,ySize,xChars,yChars,fill,flags; public short show,reservedSize;
        public IntPtr reserved2,input,output,error;
    }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process,thread; public int pid,tid; }
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO startup; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,byte[] info,int length);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,int code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int type,byte[] info,int length,IntPtr returned);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,int flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,int flags,IntPtr environment,string cwd,ref STARTUPINFOEX startup,out PROCESS_INFORMATION info);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,int timeout);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string path,uint access,int share,IntPtr attributes,int creation,int flags,IntPtr template);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(IntPtr handle,StringBuilder path,int size,int flags);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFileAttributes(string path);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,int mask,int flags);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr handle,byte[] info);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool WriteFile(IntPtr handle,byte[] bytes,int count,out int written,IntPtr overlapped);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool FlushFileBuffers(IntPtr handle);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle,out ulong created,out ulong exited,out ulong kernel,out ulong user);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool DeleteFile(string path);
    [StructLayout(LayoutKind.Sequential)] struct IO_STATUS_BLOCK { public IntPtr status,information; }
    [DllImport("ntdll.dll")] static extern int NtSetInformationFile(IntPtr file,out IO_STATUS_BLOCK status,byte[] info,int length,int type);
    [DllImport("ntdll.dll")] static extern uint RtlNtStatusToDosError(int status);
    static readonly IntPtr Invalid = new IntPtr(-1);
    static void Check(bool ok,string name) { if(!ok) throw new IOException(name+": Win32 "+Marshal.GetLastWin32Error()); }
    static string Physical(IntPtr handle) {
        var result=new StringBuilder(32768); uint n=GetFinalPathNameByHandle(handle,result,result.Capacity,0);
        Check(n>0 && n<result.Capacity,"GetFinalPathNameByHandle"); string path=result.ToString();
        return path.StartsWith(@"\\?\UNC\") ? @"\\"+path.Substring(8) : path.StartsWith(@"\\?\") ? path.Substring(4) : path;
    }
    static string Quote(string value) {
        var text=new StringBuilder("\""); int slashes=0;
        foreach(char c in value) { if(c=='\\') slashes++; else { text.Append('\\',c=='"'?slashes*2+1:slashes); text.Append(c); slashes=0; } }
        return text.Append('\\',slashes*2).Append('"').ToString();
    }
    static IntPtr StateFile(string path,uint access,int share) {
        IntPtr file=CreateFile(path,access|0x80,share,IntPtr.Zero,4,0x00200080,IntPtr.Zero); Check(file!=Invalid,"Open private state file");
        try {
            byte[] info=new byte[52]; Check(GetFileInformationByHandle(file,info),"State file information");
            Check((BitConverter.ToUInt32(info,0)&0x410)==0 && BitConverter.ToUInt32(info,40)==1,"State file must be regular, non-reparse and not hard-linked");
            Check(String.Equals(Physical(file),Path.GetFullPath(path),StringComparison.OrdinalIgnoreCase),"State file physical path changed"); return file;
        } catch { CloseHandle(file); throw; }
    }
    static void AtomicText(string state,IntPtr parent,string name,string text) {
        Check(name.IndexOfAny(new char[]{'\\','/',':','\0'})<0,"Single state component required");
        string temp=Path.Combine(state,".supervisor-"+Guid.NewGuid().ToString("N")+".tmp");
        IntPtr file=CreateFile(temp,0x40110080,0,IntPtr.Zero,1,0x00200080,IntPtr.Zero); Check(file!=Invalid,"Create atomic state file");
        bool moved=false;
        try {
            byte[] bytes=new UTF8Encoding(false).GetBytes(text); int offset=0;
            while(offset<bytes.Length) {
                int count=Math.Min(65536,bytes.Length-offset),written; byte[] part=new byte[count]; Array.Copy(bytes,offset,part,0,count);
                Check(WriteFile(file,part,count,out written,IntPtr.Zero)&&written>0,"Write atomic state"); offset+=written;
            }
            Check(FlushFileBuffers(file),"Flush atomic state");
            byte[] filename=Encoding.Unicode.GetBytes(name),info=new byte[20+filename.Length]; info[0]=1;
            Array.Copy(BitConverter.GetBytes(parent.ToInt64()),0,info,8,8); Array.Copy(BitConverter.GetBytes(filename.Length),0,info,16,4); Array.Copy(filename,0,info,20,filename.Length);
            for(int attempt=0;;attempt++) {
                IO_STATUS_BLOCK status; int code=NtSetInformationFile(file,out status,info,info.Length,10);
                if(code>=0) { moved=true; break; }
                uint win32=RtlNtStatusToDosError(code);
                if(attempt>=4 || (win32!=5 && win32!=32 && win32!=33)) throw new IOException("Atomic state rename: Win32 "+win32);
                Thread.Sleep(Math.Min(50<<attempt,200));
            }
        } finally { CloseHandle(file); if(!moved) DeleteFile(temp); }
    }
    static List<IntPtr> Pin(string directory) {
        var handles=new List<IntPtr>();
        try {
            string full=Path.GetFullPath(directory),root=Path.GetPathRoot(full),path=root;
            var paths=new List<string>(); paths.Add(root);
            foreach(string component in full.Substring(root.Length).Split(new char[]{'\\'},StringSplitOptions.RemoveEmptyEntries)) { path=Path.Combine(path,component); paths.Add(path); }
            foreach(string item in paths) {
                uint attributes=GetFileAttributes(item); Check(attributes!=0xffffffff && (attributes&0x410)==0x10,"Private path must be directory without reparse points");
                IntPtr handle=CreateFile(item,0x81,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero); Check(handle!=Invalid,"Pin private directory"); handles.Add(handle);
                Check(String.Equals(Physical(handle).TrimEnd('\\'),item.TrimEnd('\\'),StringComparison.OrdinalIgnoreCase),"Directory physical path changed");
            }
            return handles;
        } catch { foreach(IntPtr h in handles) CloseHandle(h); throw; }
    }
    static void StartCleanup(string state,IntPtr directory,Dictionary<string,object> request) {
        if(!request.ContainsKey("schema")||Convert.ToInt32(request["schema"])!=1)throw new IOException("Invalid cleanup request schema");
        string id=request["installationId"] as string,nonce=request["nonce"] as string,callerCreated=request["callerCreated"] as string;int caller=Convert.ToInt32(request["callerPid"]);ulong created;
        if(id==null||nonce==null||!Regex.IsMatch(id,@"^[a-f0-9]{32}$")||!Regex.IsMatch(nonce,@"^[a-f0-9]{32}$")||caller<=0||!UInt64.TryParse(callerCreated,out created))throw new IOException("Invalid cleanup request identity");
        OwnedCleanup.Verify(state,id);
        string image=System.Reflection.Assembly.GetExecutingAssembly().Location;
        using(var imageStream=new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(StateFile(image,0x80000000,1),true),FileAccess.Read)) {
            if(imageStream.Length<=0||imageStream.Length>1024*1024)throw new IOException("Invalid cleanup helper size");
            byte[] bytes=new byte[(int)imageStream.Length];int offset=0,n;while(offset<bytes.Length&&(n=imageStream.Read(bytes,offset,bytes.Length-offset))>0)offset+=n;if(offset!=bytes.Length)throw new IOException("Truncated helper");
            string hash;using(var sha=SHA256.Create())hash=BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();
            string script="$ErrorActionPreference='Stop';try{$bytes=[IO.File]::ReadAllBytes($env:CR_CLEANUP_IMAGE);$sha=[Security.Cryptography.SHA256]::Create();try{$hash=[BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()};if($hash -ne $env:CR_CLEANUP_SHA){throw 'Helper hash mismatch'};$asm=[Reflection.Assembly]::Load($bytes);$asm.GetType('OwnedCleanup').GetMethod('Run').Invoke($null,@($env:CR_CLEANUP_ROOT,$env:CR_CLEANUP_ID,$env:CR_CLEANUP_NONCE,[int]$env:CR_CLEANUP_HOST,$env:CR_CLEANUP_HOST_CREATED,[int]$env:CR_CLEANUP_CALLER,$env:CR_CLEANUP_CALLER_CREATED))}catch{exit 1}";
            string powershell=Environment.GetEnvironmentVariable("SystemRoot")+@"\System32\WindowsPowerShell\v1.0\powershell.exe";
            var environment=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);foreach(System.Collections.DictionaryEntry entry in Environment.GetEnvironmentVariables())environment[(string)entry.Key]=(string)entry.Value;
            var self=System.Diagnostics.Process.GetCurrentProcess();environment["CR_CLEANUP_IMAGE"]=image;environment["CR_CLEANUP_SHA"]=hash;environment["CR_CLEANUP_ROOT"]=state;environment["CR_CLEANUP_ID"]=id;environment["CR_CLEANUP_NONCE"]=nonce;environment["CR_CLEANUP_HOST"]=self.Id.ToString();environment["CR_CLEANUP_HOST_CREATED"]=self.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();environment["CR_CLEANUP_CALLER"]=caller.ToString();environment["CR_CLEANUP_CALLER_CREATED"]=callerCreated;environment.Remove("CODERAIL_STOP_FILE");environment.Remove("BUN_BE_BUN");
            IntPtr job=IntPtr.Zero,attributes=IntPtr.Zero,jobs=IntPtr.Zero,handles=IntPtr.Zero,block=IntPtr.Zero;bool initialized=false,handedOff=false;PROCESS_INFORMATION actor=new PROCESS_INFORMATION();
            try {
                job=CreateJobObject(IntPtr.Zero,null);Check(job!=IntPtr.Zero,"Create cleanup Job");byte[] limits=new byte[144];Array.Copy(BitConverter.GetBytes(0x2000),0,limits,16,4);Check(SetInformationJobObject(job,9,limits,limits.Length),"Cleanup kill-on-close");Check(SetHandleInformation(job,1,1),"Inherit cleanup Job reference");
                environment["CODERAIL_ACTOR_JOB"]=job.ToInt64().ToString();var text=new StringBuilder();foreach(var entry in environment)text.Append(entry.Key).Append('=').Append(entry.Value).Append('\0');text.Append('\0');block=Marshal.StringToHGlobalUni(text.ToString());
                IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);attributes=Marshal.AllocHGlobal(size);Check(InitializeProcThreadAttributeList(attributes,2,0,ref size),"Cleanup attributes");initialized=true;
                jobs=Marshal.AllocHGlobal(IntPtr.Size);Marshal.WriteIntPtr(jobs,job);handles=Marshal.AllocHGlobal(IntPtr.Size);Marshal.WriteIntPtr(handles,job);
                Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x2000d),jobs,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero),"Cleanup creation Job list");Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20002),handles,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero),"Cleanup explicit inherited handle");
                var startup=new STARTUPINFOEX();startup.startup.cb=Marshal.SizeOf(typeof(STARTUPINFOEX));startup.attributes=attributes;
                string parent=state.Substring(0,state.LastIndexOf('\\'));if(parent.Length==2)parent+="\\";
                var command=new StringBuilder(Quote(powershell)+" -NoLogo -NoProfile -NonInteractive -EncodedCommand "+Convert.ToBase64String(Encoding.Unicode.GetBytes(script)));
                Check(CreateProcess(powershell,command,IntPtr.Zero,IntPtr.Zero,true,0x08080404,block,parent,ref startup,out actor),"Create cleanup actor in separate Job");Check(SetHandleInformation(job,1,0),"Clear host Job inheritance");Check(ResumeThread(actor.thread)!=0xffffffff,"Resume cleanup actor");CloseHandle(actor.thread);actor.thread=IntPtr.Zero;
                ulong actorCreated,exited,kernel,user;Check(GetProcessTimes(actor.process,out actorCreated,out exited,out kernel,out user),"Actor creation identity");
                string ready=Path.Combine(state,"cleanup-ready-"+nonce);DateTime deadline=DateTime.UtcNow.AddSeconds(10);
                for(;;) {
                    if(WaitForSingleObject(actor.process,0)==0)throw new IOException("Cleanup actor exited before handoff");
                    if(File.Exists(ready)){var data=OwnedCleanup.ReadControl(state,directory,"cleanup-ready-"+nonce,false);if(Convert.ToInt32(data["pid"])!=actor.pid||!String.Equals(data["created"] as string,actorCreated.ToString(),StringComparison.Ordinal)||!String.Equals(data["nonce"] as string,nonce,StringComparison.Ordinal)||!String.Equals(data["jobHandle"] as string,job.ToInt64().ToString(),StringComparison.Ordinal))throw new IOException("Cleanup actor ready identity mismatch");break;}
                    if(DateTime.UtcNow>deadline)throw new IOException("Cleanup actor ready timeout");Thread.Sleep(50);
                }
                handedOff=true;
            } finally {
                if(!handedOff&&job!=IntPtr.Zero){Check(TerminateJobObject(job,1),"Abort cleanup actor Job");if(actor.process!=IntPtr.Zero)Check(WaitForSingleObject(actor.process,10000)==0,"Aborted actor exited");}
                if(initialized)DeleteProcThreadAttributeList(attributes);if(attributes!=IntPtr.Zero)Marshal.FreeHGlobal(attributes);if(jobs!=IntPtr.Zero)Marshal.FreeHGlobal(jobs);if(handles!=IntPtr.Zero)Marshal.FreeHGlobal(handles);if(block!=IntPtr.Zero)Marshal.FreeHGlobal(block);if(actor.thread!=IntPtr.Zero)CloseHandle(actor.thread);if(actor.process!=IntPtr.Zero)CloseHandle(actor.process);if(job!=IntPtr.Zero)CloseHandle(job);
            }
        }
    }
    static void UpdateHealth(string state,IntPtr directory,PROCESS_INFORMATION child,DateTime started,string version) {
        DateTime deadline=DateTime.UtcNow.AddSeconds(5);string reason="No state yet";
        while(DateTime.UtcNow<deadline) {
            if(WaitForSingleObject(child.process,0)!=258)throw new IOException("Candidate exited before local bootstrap health");
            try {
                var data=OwnedCleanup.ReadControl(state,directory,"state.json",false);DateTime at;
                if(Convert.ToInt32(data["pid"])==child.pid&&String.Equals(data["version"] as string,version,StringComparison.Ordinal)&&DateTime.TryParse(data["at"] as string,null,System.Globalization.DateTimeStyles.RoundtripKind,out at)&&at.ToUniversalTime()>=started.AddMilliseconds(-100)&&((data["state"] as string)=="connected"||(data["state"] as string)=="connecting"))return;
                reason="State identity/version/time/bootstrap state does not match candidate";
            }catch(Exception error){reason=error.Message;}
            Thread.Sleep(50);
        }
        throw new IOException("Candidate local bootstrap health timed out: "+reason);
    }
    static int Main(string[] args) {
        bool installedMode=args.Length==1&&args[0]=="--installed";
        if(installedMode){string directory=Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);args=new string[]{directory,Path.Combine(directory,@"bin\current\coderail.exe"),"run"};}
        if(args.Length<2) return 64;
        string state=Path.GetFullPath(args[0]),exe=Path.GetFullPath(args[1]);
        OwnedCleanup.UpdatePlan update=null;bool rollback=false;
        var pins=new List<IntPtr>(); IntPtr job=IntPtr.Zero,attributes=IntPtr.Zero,jobList=IntPtr.Zero,handleList=IntPtr.Zero; PROCESS_INFORMATION child=new PROCESS_INFORMATION(); bool initialized=false; NativeLogPipe pump=null;
        string nonce=Guid.NewGuid().ToString("N"),stop=Path.Combine(state,"stop-"+nonce),request=Path.Combine(state,"bridge-stop-"+nonce);
        try {
            pins=Pin(state);
#if CODERAIL_POC
            OwnedCleanup.UpdateStep=delegate(string step){if(Environment.GetEnvironmentVariable("CODERAIL_POC_UPDATE_CRASH")==step)Environment.Exit(42);};
#endif
            // A second startup cannot replace another instance's identity/control file.
            using(var lease=new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(StateFile(Path.Combine(state,"supervisor.lock"),0xc0100000,0),true),FileAccess.ReadWrite)) {
                OwnedCleanup.RecoverUpdateAtStartup(state);
                bool restart;
                do {
                restart=false;
                nonce=Guid.NewGuid().ToString("N"); stop=Path.Combine(state,"stop-"+nonce); request=Path.Combine(state,"bridge-stop-"+nonce);
                using(var owned=installedMode?OwnedCleanup.HoldInstalledStartup(state,update!=null?update.sha:null):null)
                using(var executable=new FileStream(exe,FileMode.Open,FileAccess.Read,FileShare.Read)) {
                    string actual=Physical(executable.SafeFileHandle.DangerousGetHandle());
                    if(installedMode&&!String.Equals(actual,exe,StringComparison.Ordinal))throw new IOException("Installed image physical path changed");
                    Environment.SetEnvironmentVariable("CODERAIL_HOME",state);
                    Environment.SetEnvironmentVariable("CODERAIL_STOP_FILE",request);
                    Environment.SetEnvironmentVariable("BUN_BE_BUN",null);
                    job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero,"CreateJobObject");
                    byte[] limits=new byte[144]; Array.Copy(BitConverter.GetBytes(0x2000),0,limits,16,4); Check(SetInformationJobObject(job,9,limits,limits.Length),"Job kill-on-close");
                    pump=new NativeLogPipe(state,10*1024*1024);
                    IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);
                    attributes=Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(attributes,2,0,ref size),"Initialize attributes"); initialized=true;
                    jobList=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobList,job);
                    Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x2000d),jobList,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero),"Job assignment during CreateProcess");
                    handleList=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(handleList,pump.WriteHandle);
                    Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20002),handleList,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero),"Explicit inherited log handle list");
                    var startup=new STARTUPINFOEX(); startup.startup.cb=Marshal.SizeOf(typeof(STARTUPINFOEX)); startup.startup.flags=0x100; startup.startup.output=pump.WriteHandle; startup.startup.error=pump.WriteHandle; startup.attributes=attributes;
                    var command=new StringBuilder(Quote(actual)); for(int i=2;i<args.Length;i++) command.Append(' ').Append(Quote(args[i]));
                    Check(CreateProcess(actual,command,IntPtr.Zero,IntPtr.Zero,true,0x08080404,IntPtr.Zero,state,ref startup,out child),"CreateProcess suspended with Job list");
                    pump.ChildStarted(); DateTime bootStarted=DateTime.UtcNow;
                    Check(ResumeThread(child.thread)!=0xffffffff,"ResumeThread"); CloseHandle(child.thread); child.thread=IntPtr.Zero;
                    var self=System.Diagnostics.Process.GetCurrentProcess();
                    AtomicText(state,pins[pins.Count-1],"supervisor.txt",self.Id+"\n"+child.pid+"\n"+nonce+"\n"+self.StartTime.ToUniversalTime().ToFileTimeUtc()+"\n1\n");
                    if(update!=null) {
                        try {UpdateHealth(state,pins[pins.Count-1],child,bootStarted,update.version);OwnedCleanup.CommitUpdate(update);AtomicText(state,pins[pins.Count-1],"update-result-"+update.nonce,new JavaScriptSerializer().Serialize(new Dictionary<string,object>{{"status","committed"},{"version",update.version}}));update=null;}
                        catch(Exception error){rollback=true;restart=true;AtomicText(state,pins[pins.Count-1],"update-error-"+update.nonce+".txt",error.ToString());}
                    }
                    while(!rollback&&WaitForSingleObject(child.process,100)==258) {
                        pump.ThrowIfFailed();
#if CODERAIL_POC
                        if(File.Exists(Path.Combine(state,"crash-"+nonce))) Environment.Exit(3); // Test-only abnormal exit.
#endif
                        if(File.Exists(stop)) {
                            AtomicText(state,pins[pins.Count-1],Path.GetFileName(request),"stop");
                            WaitForSingleObject(child.process,2000); break;
                        }
                        if(File.Exists(Path.Combine(state,"cleanup-"+nonce))) {
                            string cleanupNonce=nonce;
                            try {
                                var plan=OwnedCleanup.ReadControl(state,pins[pins.Count-1],"cleanup-"+nonce,true);
                                if(plan.ContainsKey("nonce")&&Regex.IsMatch(plan["nonce"] as string??"",@"^[a-f0-9]{32}$"))cleanupNonce=(string)plan["nonce"];
                                StartCleanup(state,pins[pins.Count-1],plan);
                                AtomicText(state,pins[pins.Count-1],Path.GetFileName(request),"stop");WaitForSingleObject(child.process,2000);break;
                            } catch(Exception error) {AtomicText(state,pins[pins.Count-1],"cleanup-error-"+cleanupNonce+".txt",error.ToString());}
                        }
                        if(File.Exists(Path.Combine(state,"update-"+nonce))) {
                            string updateNonce=nonce;
                            try {
                                var plan=OwnedCleanup.ReadControl(state,pins[pins.Count-1],"update-"+nonce,true);
                                if(plan.ContainsKey("nonce")&&Regex.IsMatch(plan["nonce"] as string??"",@"^[a-f0-9]{32}$"))updateNonce=(string)plan["nonce"];
                                update=OwnedCleanup.PrepareUpdate(state,plan);
                                AtomicText(state,pins[pins.Count-1],"update-ready-"+update.nonce,new JavaScriptSerializer().Serialize(new Dictionary<string,object>{{"status","accepted"},{"nonce",update.nonce}}));
                                restart=true;AtomicText(state,pins[pins.Count-1],Path.GetFileName(request),"stop");WaitForSingleObject(child.process,2000);break;
                            }catch(Exception error){update=null;AtomicText(state,pins[pins.Count-1],"update-error-"+updateNonce+".txt",error.ToString());}
                        }
                        if(File.Exists(Path.Combine(state,"restart-"+nonce))) {
                            restart=true; AtomicText(state,pins[pins.Count-1],Path.GetFileName(request),"stop");
                            WaitForSingleObject(child.process,2000); break;
                        }
                    }
                }
                if(initialized) { DeleteProcThreadAttributeList(attributes); initialized=false; }
                if(attributes!=IntPtr.Zero) { Marshal.FreeHGlobal(attributes); attributes=IntPtr.Zero; }
                if(jobList!=IntPtr.Zero) { Marshal.FreeHGlobal(jobList); jobList=IntPtr.Zero; }
                if(handleList!=IntPtr.Zero) { Marshal.FreeHGlobal(handleList); handleList=IntPtr.Zero; }
                if(job!=IntPtr.Zero) {
                    Check(TerminateJobObject(job,1),"Drain old Bridge Job");
                    byte[] accounting=new byte[48]; int waited=0;
                    for(;;) {
                        Check(QueryInformationJobObject(job,1,accounting,accounting.Length,IntPtr.Zero),"Old Job accounting");
                        if(BitConverter.ToUInt32(accounting,40)==0) break;
                        Check(waited<10000,"Old Job did not drain"); Thread.Sleep(20); waited+=20;
                    }
                    CloseHandle(job); job=IntPtr.Zero;
                }
                if(child.process!=IntPtr.Zero) { Check(WaitForSingleObject(child.process,10000)==0,"Old Bridge drained"); CloseHandle(child.process); child.process=IntPtr.Zero; }
                if(pump!=null) { pump.Finish(); pump.Dispose(); pump=null; }
                if(update!=null) {
                    if(rollback) {OwnedCleanup.RollbackUpdate(update);AtomicText(state,pins[pins.Count-1],"update-result-"+update.nonce,"{\"status\":\"rolled-back\"}");update=null;rollback=false;restart=true;}
                    else {
                        try {OwnedCleanup.WaitUpdateCaller(update);OwnedCleanup.ApplyUpdate(update);}
                        catch(Exception error){if(update.prepared)OwnedCleanup.RollbackUpdate(update);AtomicText(state,pins[pins.Count-1],"update-error-"+update.nonce+".txt",error.ToString());AtomicText(state,pins[pins.Count-1],"update-result-"+update.nonce,"{\"status\":\"rolled-back\"}");update=null;restart=true;}
                    }
                }
                } while(restart);
            }
            return 0;
        } catch(Exception error) {
            // Never write through a rejected state Junction just to record its error.
            if(pins.Count>0) try { AtomicText(state,pins[pins.Count-1],"supervisor-error.txt",error.ToString()); } catch { }
            return 1;
        } finally {
            if(initialized) DeleteProcThreadAttributeList(attributes);
            if(attributes!=IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if(jobList!=IntPtr.Zero) Marshal.FreeHGlobal(jobList);
            if(handleList!=IntPtr.Zero) Marshal.FreeHGlobal(handleList);
            if(job!=IntPtr.Zero) CloseHandle(job);
            if(child.thread!=IntPtr.Zero) CloseHandle(child.thread);
            if(child.process!=IntPtr.Zero) CloseHandle(child.process);
            if(pump!=null) try { pump.Dispose(); } catch { }
            foreach(IntPtr handle in pins) CloseHandle(handle);
        }
    }
}
