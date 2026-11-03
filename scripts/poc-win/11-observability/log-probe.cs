// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
using System;
class LogProbe {
    static int Main(string[] args){try{using(var log=new OwnedLog(args[0],Int32.Parse(args[1])))using(var input=Console.OpenStandardInput()){byte[] bytes=new byte[7];int n;while((n=input.Read(bytes,0,bytes.Length))>0)log.Write(bytes,n,false);log.Write(bytes,0,true);}return 0;}catch(Exception error){Console.Error.WriteLine(error);return 1;}}
}
