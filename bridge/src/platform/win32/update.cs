// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// Native generation transaction, owned by the persistent user supervisor.
public static partial class OwnedCleanup {
    public sealed class UpdatePlan {
        public string root,id,nonce,sha,version,callerCreated,pruneHash;
        public int callerPid;public long size;public bool prepared;
        public Dictionary<string,object> old;
    }
#if CODERAIL_POC
    public static Action<string> UpdateStep;
#endif
    static string Text(Dictionary<string,object> data,string key) {object value;return data.TryGetValue(key,out value)?value as string:null;}
    static bool Version(string value){return value!=null&&Regex.IsMatch(value,@"^\d+\.\d+\.\d+\+\d+$");}
    static bool Sha(string value){return value!=null&&Regex.IsMatch(value,@"^[a-f0-9]{64}$");}
    static Dictionary<string,object> Staged(UpdatePlan plan){return new Dictionary<string,object>{{"installationId",plan.id},{"previous",plan.root+@"\bin\current\coderail.exe"},{"executable",plan.root+@"\updates\"+plan.sha+@"\coderail.exe"},{"version",plan.version},{"sha256",plan.sha},{"size",plan.size}};}
    static void UpdateJournal(UpdatePlan plan,IntPtr root,string status){AtomicControl(plan.root,root,"update.json",new JavaScriptSerializer().Serialize(new Dictionary<string,object>{{"schema",1},{"installationId",plan.id},{"status",status},{"old",plan.old},{"staged",Staged(plan)}}));}
    static void Step(string label){
#if CODERAIL_POC
        if(UpdateStep!=null)UpdateStep(label);
#endif
    }
    static void RenameGeneration(Node node,Node parent,string name){
        Component(name);byte[] text=Encoding.Unicode.GetBytes(name),info=new byte[20+text.Length];
        Array.Copy(BitConverter.GetBytes(parent.handle.ToInt64()),0,info,8,8);Array.Copy(BitConverter.GetBytes(text.Length),0,info,16,4);Array.Copy(text,0,info,20,text.Length);
        // A directory with an open file in it can't be renamed, and Windows' Program Compatibility Assistant (and
        // antivirus) open an image for seconds after its process exits: wait up to about 30 s for them.
        for(int attempt=0;;attempt++){
            IO_STATUS_BLOCK status;int code=NtSetInformationFile(node.handle,out status,info,info.Length,10);
            if(code>=0)return;uint win32=RtlNtStatusToDosError(code);
            if(attempt>=150||(win32!=5&&win32!=32&&win32!=33))Status(code,"Rename update generation");
            System.Threading.Thread.Sleep(200);
        }
    }
    static Node Generation(Node parent,string name,bool optional){
        bool exists=false;foreach(Entry entry in Entries(parent))if(String.Equals(entry.name,name,StringComparison.OrdinalIgnoreCase)){exists=true;break;}
        if(!exists){if(optional)return null;throw new IOException("Missing generation: "+name);}
        Node result=Child(parent.handle,parent.path,name,true);
        try{foreach(Entry entry in Entries(result))if(entry.name!="coderail.exe")throw new IOException("Unknown file in binary generation");return result;}catch{result.Dispose();throw;}
    }
    static string ImageHash(Node image,out long size){
        byte[] info=Information(image.handle);ulong length=((ulong)BitConverter.ToUInt32(info,32)<<32)|BitConverter.ToUInt32(info,36);if(length<64||length>1024UL*1024*1024)throw new IOException("Invalid update image length");size=(long)length;
        using(var stream=new FileStream(new SafeFileHandle(image.handle,false),FileAccess.Read)){
            byte[] header=new byte[64];if(stream.Read(header,0,64)!=64||header[0]!=77||header[1]!=90)throw new IOException("Invalid update DOS header");uint offset=BitConverter.ToUInt32(header,60);if(offset+6UL>length)throw new IOException("Invalid update PE offset");stream.Position=offset;byte[] pe=new byte[6];if(stream.Read(pe,0,6)!=6||BitConverter.ToUInt32(pe,0)!=0x4550||BitConverter.ToUInt16(pe,4)!=0x8664)throw new IOException("Update must be Windows x64");
            stream.Position=0;using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","").ToLowerInvariant();
        }
    }
    static string GenerationHash(Node directory,out long size){
        if(directory==null){size=0;return null;}
        using(Node image=Child(directory.handle,directory.path,"coderail.exe",false))return ImageHash(image,out size);
    }
    static void PrunePrevious(Node previous,string expected){
        if(!Sha(expected))throw new IOException("Previous generation has no verified ownership");
        var entries=Entries(previous);if(entries.Count>0){using(Node image=Child(previous.handle,previous.path,"coderail.exe",false)){long size;if(ImageHash(image,out size)!=expected)throw new IOException("Previous generation bytes were modified");image.Delete();}}
        Step("previous-file-pruned");previous.Delete();Step("previous-pruned");
    }
    static void ValidatePlan(UpdatePlan plan){
        Verify(plan.root,plan.id);
        if(!Sha(plan.sha)||!Version(plan.version)||plan.size<64||plan.size>1024L*1024*1024||plan.old==null||Text(plan.old,"id")!=plan.id||Text(plan.old,"root")!=plan.root||Text(plan.old,"executable")!=plan.root+@"\bin\current\coderail.exe"||!Sha(Text(plan.old,"sha256"))||!Version(Text(plan.old,"version")))throw new IOException("Invalid update plan ownership");
        var pins=Pin(plan.root);try{var marker=ReadControl(plan.root,pins[pins.Count-1],"installation.json",false);if(!((Text(marker,"sha256")==Text(plan.old,"sha256")&&Text(marker,"version")==Text(plan.old,"version"))||(Text(marker,"sha256")==plan.sha&&Text(marker,"version")==plan.version)))throw new IOException("Installation marker changed outside this update");}finally{foreach(IntPtr handle in pins)CloseHandle(handle);}
    }
    public static UpdatePlan PrepareUpdate(string root,Dictionary<string,object> request){
        if(Convert.ToInt32(request["schema"])!=1||Convert.ToInt32(request["helperProtocol"])!=1)throw new IOException("Incompatible update helper protocol");
        var plan=new UpdatePlan{root=root,id=Text(request,"installationId"),nonce=Text(request,"nonce"),sha=Text(request,"sha256"),version=Text(request,"version"),size=Convert.ToInt64(request["size"]),callerPid=Convert.ToInt32(request["callerPid"]),callerCreated=Text(request,"callerCreated")};
        ulong created;if(plan.id==null||!Regex.IsMatch(plan.id,@"^[a-f0-9]{32}$")||plan.nonce==null||!Regex.IsMatch(plan.nonce,@"^[a-f0-9]{32}$")||plan.callerPid<=0||!UInt64.TryParse(plan.callerCreated,out created))throw new IOException("Invalid update caller identity");
        var pins=Pin(root);try{plan.old=ReadControl(root,pins[pins.Count-1],"installation.json",false);ValidatePlan(plan);using(Node updates=Child(pins[pins.Count-1],root,"updates",true))using(Node stage=Generation(updates,plan.sha,false)){long size;if(GenerationHash(stage,out size)!=plan.sha||size!=plan.size)throw new IOException("Staged update SHA256/size mismatch");}}finally{foreach(IntPtr handle in pins)CloseHandle(handle);}
        pins=Pin(root);try{
            // The running Bridge's startup hold (startup.cs) keeps bin read-only without delete sharing until it
            // exits, so bin is opened the same read-only way here; ApplyUpdate takes it with DELETE after the hold.
            using(Node bin=StartupChild(pins[pins.Count-1],root,"bin",true))using(Node previous=Generation(bin,"previous",true))if(previous!=null){
                var last=ReadControl(root,pins[pins.Count-1],"update.json",false);var prior=last["old"] as Dictionary<string,object>;var activated=last["staged"] as Dictionary<string,object>;
                if(Convert.ToInt32(last["schema"])!=1||Text(last,"status")!="committed"||Text(last,"installationId")!=plan.id||prior==null||activated==null||Text(prior,"id")!=plan.id||Text(prior,"root")!=root||Text(prior,"executable")!=root+@"\bin\current\coderail.exe"||!Sha(Text(prior,"sha256"))||Text(activated,"sha256")!=Text(plan.old,"sha256")||Text(activated,"version")!=Text(plan.old,"version"))throw new IOException("Previous generation is not owned by the last committed update");
                plan.pruneHash=Text(prior,"sha256");if(Entries(previous).Count>0){long size;if(GenerationHash(previous,out size)!=plan.pruneHash)throw new IOException("Previous generation SHA256 changed");}
            }
        }finally{foreach(IntPtr handle in pins)CloseHandle(handle);}
        return plan;
    }
    public static void WaitUpdateCaller(UpdatePlan plan){IntPtr caller=WaitTarget(plan.callerPid,plan.callerCreated);try{if(caller!=IntPtr.Zero)Check(WaitForSingleObject(caller,10000)==0,"Update caller did not exit after acknowledgement");}finally{if(caller!=IntPtr.Zero)CloseHandle(caller);}}
    public static void ApplyUpdate(UpdatePlan plan){
        ValidatePlan(plan);var pins=Pin(plan.root);
        try{IntPtr parent=pins[pins.Count-1];using(Node bin=Child(parent,plan.root,"bin",true))using(Node updates=Child(parent,plan.root,"updates",true))using(Node current=Generation(bin,"current",false))using(Node previous=Generation(bin,"previous",true))using(Node stage=Generation(updates,plan.sha,false)){
            long size;
            if(GenerationHash(current,out size)!=Text(plan.old,"sha256")||GenerationHash(stage,out size)!=plan.sha||size!=plan.size)throw new IOException("Generation changed before update");
            // Discard only the older-than-current backup, proved by the last
            // committed journal. Current is still intact; partial pruning can be
            // resumed from an empty owned previous directory after a crash.
            if(previous!=null)PrunePrevious(previous,plan.pruneHash);
            UpdateJournal(plan,parent,"prepared");plan.prepared=true;Step("prepared");
            RenameGeneration(current,bin,"previous");Step("old-renamed");UpdateJournal(plan,parent,"old-moved");Step("old-moved");
            RenameGeneration(stage,bin,"current");Step("candidate-renamed");UpdateJournal(plan,parent,"candidate-active");Step("candidate-active");
        }}finally{foreach(IntPtr handle in pins)CloseHandle(handle);}
    }
    public static void CommitUpdate(UpdatePlan plan){
        ValidatePlan(plan);var pins=Pin(plan.root);try{IntPtr parent=pins[pins.Count-1];var marker=new Dictionary<string,object>(plan.old);marker["sha256"]=plan.sha;marker["version"]=plan.version;AtomicControl(plan.root,parent,"installation.json",new JavaScriptSerializer().Serialize(marker));Step("marker-updated");UpdateJournal(plan,parent,"committed");Step("committed");}finally{foreach(IntPtr handle in pins)CloseHandle(handle);}
    }
    public static void RollbackUpdate(UpdatePlan plan){
        ValidatePlan(plan);var pins=Pin(plan.root);
        try{IntPtr parent=pins[pins.Count-1];using(Node bin=Child(parent,plan.root,"bin",true))using(Node updates=Child(parent,plan.root,"updates",true))using(Node current=Generation(bin,"current",true))using(Node previous=Generation(bin,"previous",true))using(Node stage=Generation(updates,plan.sha,true)){
            long size,csize,psize,ssize;string c=GenerationHash(current,out csize),p=GenerationHash(previous,out psize),s=GenerationHash(stage,out ssize),old=Text(plan.old,"sha256");
            if(c==old&&previous==null&&s==plan.sha&&ssize==plan.size){}
            else if(current==null&&p==old&&s==plan.sha&&ssize==plan.size)RenameGeneration(previous,bin,"current");
            else if(c==plan.sha&&csize==plan.size&&p==old&&stage==null){RenameGeneration(current,updates,plan.sha);RenameGeneration(previous,bin,"current");}
            else throw new IOException("Ambiguous update layout; rollback refused");
            AtomicControl(plan.root,parent,"installation.json",new JavaScriptSerializer().Serialize(plan.old));UpdateJournal(plan,parent,"rolled-back");
        }}finally{foreach(IntPtr handle in pins)CloseHandle(handle);}
    }
    public static void RecoverUpdateAtStartup(string root){
        var pins=Pin(root);try{
            if(!File.Exists(Path.Combine(root,"update.json")))return;
            var journal=ReadControl(root,pins[pins.Count-1],"update.json",false);string status=Text(journal,"status");
            if(Convert.ToInt32(journal["schema"])!=1||!(status=="prepared"||status=="old-moved"||status=="candidate-active"||status=="committed"||status=="rolled-back"))throw new IOException("Invalid pending update journal");
            var next=journal["staged"] as Dictionary<string,object>;if(next==null)throw new IOException("Invalid pending artifact");
            var plan=new UpdatePlan{root=root,id=Text(journal,"installationId"),sha=Text(next,"sha256"),version=Text(next,"version"),size=Convert.ToInt64(next["size"]),old=journal["old"] as Dictionary<string,object>};
            if(Text(next,"installationId")!=plan.id||Text(next,"previous")!=root+@"\bin\current\coderail.exe"||Text(next,"executable")!=root+@"\updates\"+plan.sha+@"\coderail.exe")throw new IOException("Pending artifact ownership mismatch");
            ValidatePlan(plan);
            if(status=="committed"||status=="rolled-back"){
                var marker=ReadControl(root,pins[pins.Count-1],"installation.json",false);string expectedSha=status=="committed"?plan.sha:Text(plan.old,"sha256"),expectedVersion=status=="committed"?plan.version:Text(plan.old,"version");
                if(Text(marker,"sha256")!=expectedSha||Text(marker,"version")!=expectedVersion)throw new IOException("Completed update marker mismatch");return;
            }
            RollbackUpdate(plan);
        }finally{foreach(IntPtr handle in pins)CloseHandle(handle);}
    }
}
