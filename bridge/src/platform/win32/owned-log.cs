// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

// Single writer. Children inherit a pipe, never the rotating file handle.
sealed class OwnedLog : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct IO_STATUS_BLOCK { public IntPtr status,information; }
    [StructLayout(LayoutKind.Sequential)] struct UNICODE_STRING { public ushort length,maximum;public IntPtr buffer; }
    [StructLayout(LayoutKind.Sequential)] struct OBJECT_ATTRIBUTES { public int length;public IntPtr root,name;public uint attributes;public IntPtr security,qos; }
    [DllImport("ntdll.dll")] static extern int NtCreateFile(out IntPtr file,uint access,ref OBJECT_ATTRIBUTES attributes,out IO_STATUS_BLOCK io,IntPtr size,uint flags,uint share,uint disposition,uint options,IntPtr ea,uint eaSize);
    [DllImport("ntdll.dll")] static extern int NtSetInformationFile(IntPtr file,out IO_STATUS_BLOCK io,byte[] data,int size,int type);
    [DllImport("ntdll.dll")] static extern uint RtlNtStatusToDosError(int status);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string path,uint access,int share,IntPtr security,int disposition,int flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr file,byte[] data);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(IntPtr file,StringBuilder data,int size,int flags);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    readonly List<IntPtr> pins=new List<IntPtr>();
    readonly string root;readonly int limit;readonly Decoder decoder=new UTF8Encoding(false,false).GetDecoder();
    FileStream current;bool finished;
    static void Check(bool ok,string label){if(!ok)throw new IOException(label+": Win32 "+Marshal.GetLastWin32Error());}
    static string Physical(IntPtr handle){var text=new StringBuilder(32768);uint n=GetFinalPathNameByHandle(handle,text,text.Capacity,0);Check(n>0&&n<text.Capacity,"Log physical path");string path=text.ToString();return path.StartsWith(@"\\?\",StringComparison.Ordinal)?path.Substring(4):path;}
    static byte[] Info(IntPtr handle){var data=new byte[52];Check(GetFileInformationByHandle(handle,data),"Log information");return data;}
    public OwnedLog(string directory,int maxBytes){
        if(IntPtr.Size!=8||maxBytes<1024||maxBytes>64*1024*1024)throw new IOException("Invalid x64 log configuration");
        root=Path.GetFullPath(directory).TrimEnd('\\');limit=maxBytes;
        if(root.Length<3||root[1]!=':'||root[2]!='\\')throw new IOException("Local absolute log directory required");
        try {
            string path=root.Substring(0,3);var parts=new List<string>();parts.Add(path);
            foreach(string component in root.Substring(3).Split(new char[]{'\\'},StringSplitOptions.RemoveEmptyEntries)){path=Path.Combine(path,component);parts.Add(path);}
            foreach(string part in parts){IntPtr h=CreateFile(@"\\?\"+part,0x81,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);Check(h!=new IntPtr(-1),"Pin log directory");pins.Add(h);if((BitConverter.ToUInt32(Info(h),0)&0x410)!=0x10||!String.Equals(Physical(h).TrimEnd('\\'),part.TrimEnd('\\'),StringComparison.Ordinal))throw new IOException("Unsafe physical log directory");}
            IntPtr backup=Open("bridge.log.1",false,true);
            if(backup!=IntPtr.Zero)using(var stream=new FileStream(new SafeFileHandle(backup,true),FileAccess.ReadWrite,4096))Trim(stream);
            current=OpenCurrent();
        } catch {Dispose();throw;}
    }
    IntPtr Open(string name,bool create,bool writable){
        IntPtr text=Marshal.StringToHGlobalUni(name),unicode=IntPtr.Zero,handle;
        try {
            var value=new UNICODE_STRING();value.length=(ushort)Encoding.Unicode.GetByteCount(name);value.maximum=value.length;value.buffer=text;
            unicode=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UNICODE_STRING)));Marshal.StructureToPtr(value,unicode,false);
            var attributes=new OBJECT_ATTRIBUTES();attributes.length=Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES));attributes.root=pins[pins.Count-1];attributes.name=unicode;attributes.attributes=0x40;
            IO_STATUS_BLOCK io;int status=NtCreateFile(out handle,writable?0xc0110080u:0x110080u,ref attributes,out io,IntPtr.Zero,0x80,5,create?3u:1u,0x200060,IntPtr.Zero,0);
            if(status<0){uint code=RtlNtStatusToDosError(status);if(!create&&(code==2||code==3))return IntPtr.Zero;throw new IOException("Open log: Win32 "+code);}
            try {byte[] info=Info(handle);if((BitConverter.ToUInt32(info,0)&0x411)!=0||BitConverter.ToUInt32(info,40)!=1||!String.Equals(Physical(handle),root+"\\"+name,StringComparison.Ordinal))throw new IOException("Unsafe log file: reparse, hardlink, read-only or physical mismatch");return handle;}
            catch{CloseHandle(handle);throw;}
        }finally{if(unicode!=IntPtr.Zero)Marshal.FreeHGlobal(unicode);Marshal.FreeHGlobal(text);}
    }
    void Trim(FileStream stream){
        if(stream.Length<=limit)return;byte[] bytes=new byte[limit];stream.Seek(-limit,SeekOrigin.End);int offset=0,n;
        while(offset<bytes.Length&&(n=stream.Read(bytes,offset,bytes.Length-offset))>0)offset+=n;
        int start=0;while(start<offset&&(bytes[start]&0xc0)==0x80)start++;
        stream.SetLength(0);stream.Position=0;stream.Write(bytes,start,offset-start);stream.Flush();
    }
    FileStream OpenCurrent(){IntPtr handle=Open("bridge.log",true,true);try{var stream=new FileStream(new SafeFileHandle(handle,true),FileAccess.ReadWrite,4096);handle=IntPtr.Zero;try{Trim(stream);stream.Seek(0,SeekOrigin.End);return stream;}catch{stream.Dispose();throw;}}finally{if(handle!=IntPtr.Zero)CloseHandle(handle);}}
    void Rotate(){
        current.Flush();IntPtr backup=Open("bridge.log.1",false,false);if(backup!=IntPtr.Zero)CloseHandle(backup);
        byte[] name=Encoding.Unicode.GetBytes("bridge.log.1"),data=new byte[20+name.Length];data[0]=1;
        Array.Copy(BitConverter.GetBytes(pins[pins.Count-1].ToInt64()),0,data,8,8);Array.Copy(BitConverter.GetBytes(name.Length),0,data,16,4);Array.Copy(name,0,data,20,name.Length);
        for(int attempt=0;;attempt++){
            IO_STATUS_BLOCK io;int code=NtSetInformationFile(current.SafeFileHandle.DangerousGetHandle(),out io,data,data.Length,10);if(code>=0)break;
            uint error=RtlNtStatusToDosError(code);if(attempt>=4||(error!=5&&error!=32&&error!=33))throw new IOException("Rotate log: Win32 "+error);Thread.Sleep(Math.Min(50<<attempt,200));
        }
        current.Dispose();current=null;current=OpenCurrent();
    }
    public void Write(byte[] bytes,int count,bool final){
        if(finished)throw new IOException("Log decoder already completed");
        char[] chars=new char[count+2];int size=decoder.GetChars(bytes,0,count,chars,0,final);
        byte[] encoded=new UTF8Encoding(false).GetBytes(chars,0,size);int offset=0;
        while(offset<encoded.Length){
            int room=(int)Math.Max(0,limit-current.Length);if(room<4){Rotate();continue;}
            int n=Math.Min(room,encoded.Length-offset);
            if(offset+n<encoded.Length)while(n>0&&(encoded[offset+n]&0xc0)==0x80)n--;
            if(n==0){Rotate();continue;}current.Write(encoded,offset,n);current.Flush();offset+=n;
        }
        if(final)finished=true;
    }
    public void Dispose(){if(current!=null){current.Dispose();current=null;}foreach(IntPtr h in pins)CloseHandle(h);pins.Clear();}
}

sealed class NativeLogPipe : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES {public int length;public IntPtr descriptor;[MarshalAs(UnmanagedType.Bool)] public bool inherit;}
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SECURITY_ATTRIBUTES security,int size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,int mask,int flags);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    readonly OwnedLog log;FileStream input;Thread thread;IntPtr writer;volatile Exception failure;bool disposed;
    public IntPtr WriteHandle {get{return writer;}}
    public NativeLogPipe(string directory,int limit){
        log=new OwnedLog(directory,limit);IntPtr read=IntPtr.Zero;
        try {
            var security=new SECURITY_ATTRIBUTES();security.length=Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));security.inherit=true;
            if(!CreatePipe(out read,out writer,ref security,65536)||!SetHandleInformation(read,1,0))throw new IOException("Create log pipe: Win32 "+Marshal.GetLastWin32Error());
            input=new FileStream(new SafeFileHandle(read,true),FileAccess.Read,4096);read=IntPtr.Zero;
            thread=new Thread(Pump);thread.IsBackground=true;thread.Start();
        } catch {if(read!=IntPtr.Zero)CloseHandle(read);Dispose();throw;}
    }
    void Pump(){try{byte[] bytes=new byte[4096];int n;while((n=input.Read(bytes,0,bytes.Length))>0)log.Write(bytes,n,false);log.Write(bytes,0,true);}catch(Exception error){failure=error;}finally{input.Dispose();}}
    public void ChildStarted(){if(writer!=IntPtr.Zero){CloseHandle(writer);writer=IntPtr.Zero;}}
    public void ThrowIfFailed(){if(failure!=null)throw new IOException("Log pipe failed",failure);}
    public void Finish(){ChildStarted();if(thread!=null&&!thread.Join(10000))throw new IOException("Log pipe did not reach EOF after Job drain");ThrowIfFailed();}
    public void Dispose(){if(disposed)return;disposed=true;ChildStarted();try{if(thread!=null&&!thread.Join(10000))throw new IOException("Log pipe disposal timed out");}finally{if(input!=null)input.Dispose();log.Dispose();}}
}
