// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// File-only candidate. No process termination, shell invocation, elevation or path-recursive deletion.
public static partial class OwnedCleanup {
    [StructLayout(LayoutKind.Sequential)] struct UNICODE_STRING { public ushort length,maximum; public IntPtr buffer; }
    [StructLayout(LayoutKind.Sequential)] struct OBJECT_ATTRIBUTES { public uint length; public IntPtr root,name; public uint attributes; public IntPtr security,quality; }
    [StructLayout(LayoutKind.Sequential)] struct IO_STATUS_BLOCK { public IntPtr status,information; }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string path,uint access,int share,IntPtr security,int creation,int flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr handle,byte[] info);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(IntPtr handle,StringBuilder text,int length,int flags);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(IntPtr handle,int type,byte[] info,int length);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool WriteFile(IntPtr handle,byte[] data,int count,out int written,IntPtr overlapped);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool FlushFileBuffers(IntPtr handle);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool DeleteFile(string path);
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out ulong created,out ulong exited,out ulong kernel,out ulong user);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,int timeout);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,int mask,int flags);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool member);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("ntdll.dll")] static extern int NtCreateFile(out IntPtr file,uint access,ref OBJECT_ATTRIBUTES attributes,out IO_STATUS_BLOCK status,IntPtr allocation,uint fileAttributes,uint sharing,uint disposition,uint options,IntPtr ea,uint eaLength);
    [DllImport("ntdll.dll")] static extern int NtQueryDirectoryFile(IntPtr file,IntPtr evt,IntPtr apc,IntPtr context,out IO_STATUS_BLOCK status,byte[] data,uint size,int type,[MarshalAs(UnmanagedType.U1)] bool single,IntPtr name,[MarshalAs(UnmanagedType.U1)] bool restart);
    [DllImport("ntdll.dll")] static extern uint RtlNtStatusToDosError(int status);
    [DllImport("ntdll.dll")] static extern int NtSetInformationFile(IntPtr file,out IO_STATUS_BLOCK status,byte[] info,int length,int type);
    static readonly IntPtr Invalid=new IntPtr(-1);
    static readonly HashSet<string> Files=new HashSet<string>(new string[]{"installation.json","ownership.txt","update.json","update.cs","owned-log.cs","startup.cs","config.json","state.json","access.json","bridge.log","bridge.log.1","supervisor.cs","cleanup.cs","supervisor.exe","supervisor.lock","supervisor.txt","supervisor-error.txt"},StringComparer.Ordinal);
    static readonly HashSet<string> Directories=new HashSet<string>(new string[]{"bin","runtime","adapters","updates","browser"},StringComparer.Ordinal);
    static void Check(bool ok,string name) { if(!ok)throw new IOException(name+": Win32 "+Marshal.GetLastWin32Error()); }
    static void Status(int code,string name) { if(code<0)throw new IOException(name+": Win32 "+RtlNtStatusToDosError(code)); }
    static string Extended(string path) { return @"\\?\"+path; }
    static string Physical(IntPtr handle) {
        var text=new StringBuilder(32768);uint size=GetFinalPathNameByHandle(handle,text,text.Capacity,0);Check(size>0&&size<text.Capacity,"Physical path");
        string result=text.ToString();if(result.StartsWith(@"\\?\UNC\",StringComparison.Ordinal))throw new IOException("UNC cleanup is not supported");
        return result.StartsWith(@"\\?\",StringComparison.Ordinal)?result.Substring(4):result;
    }
    static byte[] Information(IntPtr handle) {var data=new byte[52];Check(GetFileInformationByHandle(handle,data),"File identity");return data;}
    static string Identity(byte[] data) {return BitConverter.ToUInt32(data,28)+":"+BitConverter.ToUInt32(data,44)+":"+BitConverter.ToUInt32(data,48);}
    static void Component(string name) {if(name.Length==0||name=="."||name==".."||name.IndexOfAny(new char[]{'\\','/',':','\0'})>=0||name.EndsWith(".")||name.EndsWith(" "))throw new IOException("Ambiguous cleanup component");}
    sealed class Node : IDisposable {
        public IntPtr handle; public string path; public bool directory;
        public Node(IntPtr value,string expected,bool isDirectory) {
            handle=value;path=expected;directory=isDirectory;
            try {
                byte[] info=Information(handle);uint attributes=BitConverter.ToUInt32(info,0);
                if((attributes&0x400)!=0||((attributes&0x10)!=0)!=directory)throw new IOException("Reparse point or unexpected file type");
                if(!directory&&BitConverter.ToUInt32(info,40)!=1)throw new IOException("Hard-linked cleanup file refused");
                if(!directory&&(attributes&1)!=0)throw new IOException("Read-only cleanup file refused before deletion");
                if(!String.Equals(Physical(handle),expected,StringComparison.Ordinal))throw new IOException("Physical cleanup path changed");
            } catch {Dispose();throw;}
        }
        public void Dispose(){if(handle!=IntPtr.Zero){CloseHandle(handle);handle=IntPtr.Zero;}}
        public void Delete(){Check(SetFileInformationByHandle(handle,4,new byte[]{1},1),"Delete owned handle");Dispose();}
    }
    static Node Child(IntPtr parent,string parentPath,string name,bool directory) {
        Component(name);IntPtr text=Marshal.StringToHGlobalUni(name),unicode=IntPtr.Zero;
        try {
            var value=new UNICODE_STRING();value.length=(ushort)Encoding.Unicode.GetByteCount(name);value.maximum=value.length;value.buffer=text;
            unicode=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UNICODE_STRING)));Marshal.StructureToPtr(value,unicode,false);
            var attributes=new OBJECT_ATTRIBUTES();attributes.length=(uint)Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES));attributes.root=parent;attributes.name=unicode;attributes.attributes=0x40;
            IntPtr result;IO_STATUS_BLOCK status;
            // Single-component no-follow relative open. File handles deny concurrent write/delete.
            for(int attempt=0;;attempt++) {
                int code=NtCreateFile(out result,directory?0x110081u:0x80110080u,ref attributes,out status,IntPtr.Zero,0x80,directory?3u:1u,1,0x200020u|(directory?1u:0x40u),IntPtr.Zero,0);
                if(code>=0)break;uint win32=RtlNtStatusToDosError(code);
                if(attempt>=4||(win32!=5&&win32!=32&&win32!=33))Status(code,"Open owned child");
                Thread.Sleep(Math.Min(50<<attempt,200));
            }
            return new Node(result,parentPath+"\\"+name,directory);
        } finally {if(unicode!=IntPtr.Zero)Marshal.FreeHGlobal(unicode);Marshal.FreeHGlobal(text);}
    }
    struct Entry {public string name;public bool directory;}
    static List<Entry> Entries(Node directory) {
        var result=new List<Entry>();bool restart=true;var bytes=new byte[65536];
        for(;;) {
            IO_STATUS_BLOCK io;int status=NtQueryDirectoryFile(directory.handle,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,out io,bytes,(uint)bytes.Length,1,false,IntPtr.Zero,restart);restart=false;
            if(unchecked((uint)status)==0x80000006)return result;Status(status,"Enumerate owned directory");
            long count=io.information.ToInt64();if(count<=0||count>bytes.Length)throw new IOException("Invalid directory information");
            int offset=0;
            while(offset+64<=count) {
                int next=BitConverter.ToInt32(bytes,offset),length=BitConverter.ToInt32(bytes,offset+60);
                if(length<0||(length&1)!=0||offset+64L+length>count)throw new IOException("Invalid native directory entry");
                string name=Encoding.Unicode.GetString(bytes,offset+64,length);
                if(name!="."&&name!="..")result.Add(new Entry{name=name,directory=(BitConverter.ToUInt32(bytes,offset+56)&0x10)!=0});
                if(next==0)break;if(next<64||offset+(long)next>=count)throw new IOException("Invalid directory entry offset");offset+=next;
            }
        }
    }
    static List<IntPtr> Pin(string path) {
        var result=new List<IntPtr>();
        try {
            string current=path.Substring(0,3);var paths=new List<string>();paths.Add(current);
            foreach(string component in path.Substring(3).Split('\\')){Component(component);current+=(current.EndsWith("\\")?"":"\\")+component;paths.Add(current);}
            foreach(string item in paths){IntPtr handle=CreateFile(Extended(item),0x81,3,IntPtr.Zero,3,0x2200000,IntPtr.Zero);Check(handle!=Invalid,"Pin cleanup directory");result.Add(handle);var info=Information(handle);if((BitConverter.ToUInt32(info,0)&0x410)!=0x10||!String.Equals(Physical(handle).TrimEnd('\\'),item.TrimEnd('\\'),StringComparison.Ordinal))throw new IOException("Cleanup ancestor changed or is a reparse point");}
            return result;
        } catch {foreach(IntPtr handle in result)CloseHandle(handle);throw;}
    }
    static void ValidateMarker(string root,Node marker,string id) {
            var info=Information(marker.handle);ulong length=((ulong)BitConverter.ToUInt32(info,32)<<32)|BitConverter.ToUInt32(info,36);
            if(length==0||length>16384)throw new IOException("Invalid ownership marker length");
            var bytes=new byte[(int)length];using(var stream=new FileStream(new SafeFileHandle(marker.handle,false),FileAccess.Read)){int offset=0,n;while(offset<bytes.Length&&(n=stream.Read(bytes,offset,bytes.Length-offset))>0)offset+=n;if(offset!=bytes.Length)throw new IOException("Truncated ownership marker");}
            var data=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(new UTF8Encoding(false,true).GetString(bytes));
            if(!data.ContainsKey("schema")||Convert.ToInt32(data["schema"])!=1||!data.ContainsKey("id")||!String.Equals(data["id"] as string,id,StringComparison.Ordinal)||!data.ContainsKey("root")||!String.Equals(data["root"] as string,root,StringComparison.Ordinal)||!data.ContainsKey("executable")||!String.Equals(data["executable"] as string,root+@"\bin\current\coderail.exe",StringComparison.Ordinal))throw new IOException("Installation ownership does not match cleanup request");
    }
    public static void Verify(string root,string id) {
        if(!Regex.IsMatch(root,@"^[A-Z]:\\")||root.EndsWith("\\")||!Regex.IsMatch(id,@"^[a-f0-9]{32}$"))throw new IOException("Invalid owned root");
        var pins=Pin(root);try{using(Node marker=Child(pins[pins.Count-1],root,"installation.json",false))ValidateMarker(root,marker,id);}finally{foreach(IntPtr handle in pins)CloseHandle(handle);}
    }
    public static Dictionary<string,object> ReadControl(string root,IntPtr parent,string name,bool consume) {
        using(Node file=Child(parent,root,name,false)) {
            try {
            byte[] info=Information(file.handle);ulong size=((ulong)BitConverter.ToUInt32(info,32)<<32)|BitConverter.ToUInt32(info,36);if(size==0||size>16384)throw new IOException("Invalid control length");
            byte[] bytes=new byte[(int)size];using(var stream=new FileStream(new SafeFileHandle(file.handle,false),FileAccess.Read)){int offset=0,n;while(offset<bytes.Length&&(n=stream.Read(bytes,offset,bytes.Length-offset))>0)offset+=n;if(offset!=bytes.Length)throw new IOException("Truncated control");}
            return new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(new UTF8Encoding(false,true).GetString(bytes));
            } finally {if(consume)file.Delete();}
        }
    }
    static void Plan(Node root,Node current,List<Node> ordered,int depth,DateTime deadline) {
        if(depth>128||DateTime.UtcNow>deadline)throw new IOException("Cleanup traversal limit exceeded");
        foreach(Entry entry in Entries(current)) {
            if(DateTime.UtcNow>deadline)throw new IOException("Cleanup traversal deadline exceeded");
            if(ordered.Count>=50000)throw new IOException("Cleanup entry limit exceeded");
            if(depth==0&&!(entry.directory?Directories.Contains(entry.name):Files.Contains(entry.name)||Regex.IsMatch(entry.name,@"^(?:stop|restart|bridge-stop|cleanup|cleanup-ready|update|update-ready|update-result)-[a-f0-9]{32}$")||Regex.IsMatch(entry.name,@"^(?:cleanup|update)-error-[a-f0-9]{32}\.txt$")||Regex.IsMatch(entry.name,@"^browser-mcp-[a-z0-9]+\.js$")))throw new IOException("Unknown installation entry: "+entry.name);
            Node child=Child(current.handle,current.path,entry.name,entry.directory);ordered.Add(child);
            if(child.directory)Plan(root,child,ordered,depth+1,deadline);
        }
    }
    public static void Remove(string path,string id) {RemoveCore(path,id,null);}
    static void RemoveCore(string path,string id,string expectedIdentity) {
        if(!Regex.IsMatch(path,@"^[A-Z]:\\")||path.EndsWith("\\")||!Regex.IsMatch(id,@"^[a-f0-9]{32}$"))throw new IOException("Physical local installation root and ownership id required");
        foreach(string known in new string[]{Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),Environment.GetEnvironmentVariable("SystemRoot"),Environment.GetEnvironmentVariable("ProgramFiles"),Environment.GetEnvironmentVariable("ProgramFiles(x86)"),Path.GetTempPath()}) {
            if(String.IsNullOrEmpty(known)||known.StartsWith(@"\\",StringComparison.Ordinal))continue;
            IntPtr handle=CreateFile(Extended(known.TrimEnd('\\')),0x80,7,IntPtr.Zero,3,0x2000000,IntPtr.Zero);
            if(handle==Invalid){int code=Marshal.GetLastWin32Error();if(code==2||code==3)continue;Check(false,"Resolve shared root");}
            try {if(String.Equals(path,Physical(handle).TrimEnd('\\'),StringComparison.Ordinal))throw new IOException("Shared/profile/system root cannot be removed");}finally{CloseHandle(handle);}
        }
        var pins=Pin(path);Node root=null;var nodes=new List<Node>();
        try {
            var original=Information(pins[pins.Count-1]);
            if(expectedIdentity!=null&&Identity(original)!=expectedIdentity)throw new IOException("Cleanup root changed while waiting for processes");
            // Convert the leaf read lease to a delete-capable relative handle,
            // retaining all ancestor pins and checking the same physical file ID.
            CloseHandle(pins[pins.Count-1]);pins.RemoveAt(pins.Count-1);
            int split=path.LastIndexOf('\\');string parent=path.Substring(0,split);if(parent.Length==2)parent+="\\";
            root=Child(pins[pins.Count-1],parent,path.Substring(split+1),true);
            if(Identity(Information(root.handle))!=Identity(original))throw new IOException("Installation root identity changed");
            using(Node marker=Child(root.handle,root.path,"installation.json",false))ValidateMarker(root.path,marker,id);
            Plan(root,root,nodes,0,DateTime.UtcNow.AddSeconds(30));
            Node ownership=null;foreach(Node node in nodes)if(node.path==root.path+"\\installation.json")ownership=node;
            if(ownership==null)throw new IOException("Ownership marker disappeared");ValidateMarker(root.path,ownership,id);
            // All paths, identities, ownership and links have been checked before deletion.
            for(int i=nodes.Count-1;i>=0;i--)nodes[i].Delete();root.Delete();
        } finally {foreach(Node node in nodes)node.Dispose();if(root!=null)root.Dispose();foreach(IntPtr handle in pins)CloseHandle(handle);}
    }
    static IntPtr WaitTarget(int pid,string expected) {
        if(pid==0)return IntPtr.Zero;ulong creation;if(pid<0||!UInt64.TryParse(expected,out creation))throw new IOException("Invalid wait target identity");
        IntPtr handle=OpenProcess(0x101000,false,pid);
        if(handle==IntPtr.Zero){int code=Marshal.GetLastWin32Error();if(code==87||code==1168)return IntPtr.Zero;Check(false,"Open exact cleanup wait target");}
        try {ulong actual,exited,kernel,user;Check(GetProcessTimes(handle,out actual,out exited,out kernel,out user),"Wait target creation time");if(actual!=creation){CloseHandle(handle);return IntPtr.Zero;}if(pid==System.Diagnostics.Process.GetCurrentProcess().Id)throw new IOException("Cleanup cannot wait for itself");return handle;}
        catch{CloseHandle(handle);throw;}
    }
    static void AtomicControl(string root,IntPtr directory,string name,string text) {
        Component(name);string temp=root+"\\.cleanup-"+Guid.NewGuid().ToString("N")+".tmp";IntPtr file=CreateFile(Extended(temp),0x40110080,0,IntPtr.Zero,1,0x200080,IntPtr.Zero);Check(file!=Invalid,"Create cleanup control");bool moved=false;
        try {
            byte[] bytes=new UTF8Encoding(false).GetBytes(text);int offset=0;
            while(offset<bytes.Length){int count=Math.Min(65536,bytes.Length-offset),written;byte[] part=new byte[count];Array.Copy(bytes,offset,part,0,count);Check(WriteFile(file,part,count,out written,IntPtr.Zero)&&written>0,"Write cleanup control");offset+=written;}
            Check(FlushFileBuffers(file),"Flush cleanup control");byte[] filename=Encoding.Unicode.GetBytes(name),info=new byte[20+filename.Length];info[0]=1;Array.Copy(BitConverter.GetBytes(directory.ToInt64()),0,info,8,8);Array.Copy(BitConverter.GetBytes(filename.Length),0,info,16,4);Array.Copy(filename,0,info,20,filename.Length);
            for(int attempt=0;;attempt++){IO_STATUS_BLOCK status;int code=NtSetInformationFile(file,out status,info,info.Length,10);if(code>=0){moved=true;break;}uint win32=RtlNtStatusToDosError(code);if(attempt>=4||(win32!=5&&win32!=32&&win32!=33))Status(code,"Rename cleanup control");Thread.Sleep(Math.Min(50<<attempt,200));}
        } finally {CloseHandle(file);if(!moved)DeleteFile(Extended(temp));}
    }
    public static void Run(string root,string id,string nonce,int hostPid,string hostCreated,int callerPid,string callerCreated) {
        if(!Regex.IsMatch(root,@"^[A-Z]:\\")||root.EndsWith("\\")||!Regex.IsMatch(id,@"^[a-f0-9]{32}$")||!Regex.IsMatch(nonce,@"^[a-f0-9]{32}$"))throw new IOException("Invalid cleanup request");
        long inherited;if(!Int64.TryParse(Environment.GetEnvironmentVariable("CODERAIL_ACTOR_JOB"),out inherited)||inherited<=0)throw new IOException("Self-owned cleanup Job required");
        bool member;IntPtr job=new IntPtr(inherited);Check(IsProcessInJob(GetCurrentProcess(),job,out member)&&member,"Cleanup actor Job membership");Check(SetHandleInformation(job,1,0),"Clear actor Job inheritance");Environment.SetEnvironmentVariable("CODERAIL_ACTOR_JOB",null);Environment.SetEnvironmentVariable("CODERAIL_STOP_FILE",null);
        var pins=Pin(root);string identity=Identity(Information(pins[pins.Count-1]));IntPtr host=IntPtr.Zero,caller=IntPtr.Zero;bool verified=false;
        try {
            using(Node marker=Child(pins[pins.Count-1],root,"installation.json",false))ValidateMarker(root,marker,id);verified=true;
            host=WaitTarget(hostPid,hostCreated);caller=WaitTarget(callerPid,callerCreated);
            var self=System.Diagnostics.Process.GetCurrentProcess();AtomicControl(root,pins[pins.Count-1],"cleanup-ready-"+nonce,new JavaScriptSerializer().Serialize(new Dictionary<string,object>{{"pid",self.Id},{"created",self.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()},{"nonce",nonce},{"jobHandle",inherited.ToString()}}));
            DateTime deadline=DateTime.UtcNow.AddSeconds(45);
            foreach(IntPtr process in new IntPtr[]{host,caller})if(process!=IntPtr.Zero)for(;;){uint wait=WaitForSingleObject(process,100);if(wait==0)break;Check(wait==258,"Cleanup process wait");if(DateTime.UtcNow>deadline)throw new IOException("Cleanup wait deadline exceeded");}
            // Keep ancestor pins; RemoveCore rechecks the original root file ID.
            CloseHandle(pins[pins.Count-1]);pins.RemoveAt(pins.Count-1);RemoveCore(root,id,identity);
        } catch(Exception failure) {
            if(verified) {
                try {var errorPins=Pin(root);try{if(Identity(Information(errorPins[errorPins.Count-1]))!=identity)throw new IOException("Error target identity changed");AtomicControl(root,errorPins[errorPins.Count-1],"cleanup-error-"+nonce+".txt",failure.ToString());}finally{foreach(IntPtr handle in errorPins)CloseHandle(handle);}}
                catch(Exception logging){throw new AggregateException("Cleanup failed and error recording failed",failure,logging);}
            }
            throw;
        } finally {if(host!=IntPtr.Zero)CloseHandle(host);if(caller!=IntPtr.Zero)CloseHandle(caller);foreach(IntPtr handle in pins)CloseHandle(handle);}
    }
    public static void Main() {}
}
