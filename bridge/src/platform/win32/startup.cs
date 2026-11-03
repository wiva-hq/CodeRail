// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
using System;
using System.IO;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;

public static partial class OwnedCleanup {
    static Node StartupChild(IntPtr parent,string path,string name,bool directory){
        Component(name);IntPtr text=Marshal.StringToHGlobalUni(name),unicode=IntPtr.Zero;
        try{
            var value=new UNICODE_STRING();value.length=(ushort)Encoding.Unicode.GetByteCount(name);value.maximum=value.length;value.buffer=text;
            unicode=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UNICODE_STRING)));Marshal.StructureToPtr(value,unicode,false);
            var attributes=new OBJECT_ATTRIBUTES();attributes.length=(uint)Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES));attributes.root=parent;attributes.name=unicode;attributes.attributes=0x40;
            IntPtr handle;IO_STATUS_BLOCK io;
            // A loader may open its mapped image with FILE_SHARE_READ only.
            // Read-only pins deny replacement without requesting DELETE access.
            Status(NtCreateFile(out handle,directory?0x100081u:0x80100080u,ref attributes,out io,IntPtr.Zero,0x80,directory?3u:1u,1,0x200020u|(directory?1u:0x40u),IntPtr.Zero,0),"Open installed startup child");
            return new Node(handle,path+"\\"+name,directory);
        }finally{if(unicode!=IntPtr.Zero)Marshal.FreeHGlobal(unicode);Marshal.FreeHGlobal(text);}
    }
    public sealed class StartupImage : IDisposable {
        readonly List<IDisposable> nodes;readonly List<IntPtr> pins;
        internal StartupImage(List<IDisposable> files,List<IntPtr> directories){nodes=files;pins=directories;}
        public void Dispose(){for(int i=nodes.Count-1;i>=0;i--)nodes[i].Dispose();nodes.Clear();foreach(IntPtr handle in pins)CloseHandle(handle);pins.Clear();}
    }
    // Hold the complete physical image path until CreateProcess has opened it.
    // candidate: the staged update's SHA-256 while it runs its health check, before CommitUpdate moves the marker to it.
    public static StartupImage HoldInstalledStartup(string root,string candidate){
        var pins=Pin(root);var nodes=new List<IDisposable>();
        try {
            var marker=ReadControl(root,pins[pins.Count-1],"installation.json",false);Verify(root,Text(marker,"id"));
            if(Convert.ToInt32(marker["schema"])!=1||!Sha(Text(marker,"sha256"))||!Version(Text(marker,"version")))throw new IOException("Invalid installed startup marker");
            Node bin=StartupChild(pins[pins.Count-1],root,"bin",true);nodes.Add(bin);
            Node current=StartupChild(bin.handle,bin.path,"current",true);nodes.Add(current);
            Node image=StartupChild(current.handle,current.path,"coderail.exe",false);nodes.Add(image);
            long size;string hash=ImageHash(image,out size);if(hash!=Text(marker,"sha256")&&(candidate==null||hash!=candidate))throw new IOException("Installed startup SHA256 mismatch");
            return new StartupImage(nodes,pins);
        }catch{for(int i=nodes.Count-1;i>=0;i--)nodes[i].Dispose();foreach(IntPtr handle in pins)CloseHandle(handle);throw;}
    }
}
