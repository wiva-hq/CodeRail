# Copyright 2026 Wiva, Inc.
# SPDX-License-Identifier: Apache-2.0
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Console]::OutputEncoding = $OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("947AAB5F-0A5C-4C13-B4D6-4BF7836FC9F8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IFileOperation {
 [PreserveSig] int Advise(IntPtr sink, out uint cookie);
 [PreserveSig] int Unadvise(uint cookie);
 [PreserveSig] int SetOperationFlags(uint flags);
 void SetProgressMessage(); void SetProgressDialog(); void SetProperties(); void SetOwnerWindow();
 void ApplyPropertiesToItem(); void ApplyPropertiesToItems(); void RenameItem(); void RenameItems();
 void MoveItem(); void MoveItems(); void CopyItem(); void CopyItems();
 [PreserveSig] int DeleteItem(IntPtr item, IntPtr sink);
 void DeleteItems(); void NewItem();
 [PreserveSig] int PerformOperations();
 [PreserveSig] int GetAnyOperationsAborted([MarshalAs(UnmanagedType.Bool)] out bool aborted);
}
public static class CodeRailRecycle {
 [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=true)]
 static extern int SHCreateItemFromParsingName(string path, IntPtr context, ref Guid iid, out IntPtr item);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern uint GetDriveType(string path);
 public static void Send(string path) {
  if (path.StartsWith(@"\\") || GetDriveType(System.IO.Path.GetPathRoot(path)) != 3)
   throw new NotSupportedException("Recycle requires a local fixed volume; permanent deletion is forbidden");
  var type=Type.GetTypeFromCLSID(new Guid("3AD05575-8857-4850-9277-11B85BDB8E09"));
  var operation=(IFileOperation)Activator.CreateInstance(type);
  IntPtr item=IntPtr.Zero;
  try {
   // Explicit RECYCLEONDELETE + ADDUNDORECORD; no permanent-delete fallback.
   Marshal.ThrowExceptionForHR(operation.SetOperationFlags(0x00080000 | 0x20000000 | 0x00100000 | 0x400 | 0x10 | 0x4));
   var iid=new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
   Marshal.ThrowExceptionForHR(SHCreateItemFromParsingName(path,IntPtr.Zero,ref iid,out item));
   Marshal.ThrowExceptionForHR(operation.DeleteItem(item,IntPtr.Zero));
   Marshal.ThrowExceptionForHR(operation.PerformOperations());
   bool aborted; Marshal.ThrowExceptionForHR(operation.GetAnyOperationsAborted(out aborted));
   if(aborted) throw new OperationCanceledException("Recycle operation aborted");
  } finally { if(item!=IntPtr.Zero) Marshal.Release(item); Marshal.FinalReleaseComObject(operation); }
 }
}
'@
[CodeRailRecycle]::Send($env:CODERAIL_RECYCLE_TARGET)
@{ recycled = $true } | ConvertTo-Json -Compress
