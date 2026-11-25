// Synthetic ordinary-user diagnostics. This is not the production adapter.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Nozeli.Diagnostics {
    public static class WindowsReplacementSemantics {
        const uint Read=0x80000000, Write=0x40000000, Delete=0x00010000;
        const uint ShareAll=7, Existing=3, Reparse=0x00200000, Backup=0x02000000;
        [StructLayout(LayoutKind.Sequential)]
        struct RenameHeader {public uint Flags; public IntPtr Root; public uint Length; public ushort FileName;}
        [StructLayout(LayoutKind.Sequential)]
        struct IoStatus {public IntPtr Status,Information;}
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
        static extern SafeFileHandle CreateFileW(string name,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
        [DllImport("kernel32.dll",SetLastError=true)]
        static extern bool SetFileInformationByHandle(SafeFileHandle file,int infoClass,IntPtr info,uint length);
        [DllImport("ntdll.dll")]
        static extern int NtSetInformationFile(SafeFileHandle file,out IoStatus io,IntPtr info,uint length,int infoClass);
        [DllImport("ntdll.dll")]
        static extern uint RtlNtStatusToDosError(int status);
        [DllImport("kernel32.dll",SetLastError=true)]
        static extern bool SetFilePointerEx(SafeFileHandle file,long distance,out long position,uint method);
        [DllImport("kernel32.dll",SetLastError=true)]
        static extern bool ReadFile(SafeFileHandle file,byte[] bytes,uint length,out uint read,IntPtr overlapped);
        [DllImport("KtmW32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
        static extern SafeFileHandle CreateTransaction(IntPtr attributes,IntPtr unit,uint options,uint isolation,uint flags,uint timeout,string description);
        [DllImport("KtmW32.dll",SetLastError=true)]
        static extern bool CommitTransaction(SafeFileHandle transaction);
        [DllImport("KtmW32.dll",SetLastError=true)]
        static extern bool RollbackTransaction(SafeFileHandle transaction);
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
        static extern SafeFileHandle CreateFileTransactedW(string name,uint access,uint share,IntPtr attributes,uint disposition,uint flags,IntPtr template,SafeFileHandle transaction,IntPtr miniVersion,IntPtr extended);
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
        static extern bool SetFileAttributesTransactedW(string name,uint attributes,SafeFileHandle transaction);
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
        static extern bool MoveFileTransactedW(string source,string target,IntPtr progress,IntPtr data,uint flags,SafeFileHandle transaction);

        static SafeFileHandle Open(string file,uint access,uint share,bool directory=false) {
            var h=CreateFileW(file,access,share,IntPtr.Zero,Existing,Reparse|(directory?Backup:0),IntPtr.Zero);
            if(h.IsInvalid)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            return h;
        }
        static string ReadPinned(SafeFileHandle file) {
            long position;uint count;byte[] bytes=new byte[128];
            if(!SetFilePointerEx(file,0,out position,0)||!ReadFile(file,bytes,(uint)bytes.Length,out count,IntPtr.Zero))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            return Encoding.UTF8.GetString(bytes,0,(int)count);
        }
        static string Quote(string value) {return "'"+value.Replace("'","''")+"'";}
        static object IndependentWrite(string file) {
            string script="$ErrorActionPreference='Stop';$writer=$null;try{$writer=[IO.File]::Open("+Quote(file)+",[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]7);$bytes=[Text.Encoding]::UTF8.GetBytes('outside!');$writer.Write($bytes,0,$bytes.Length);$writer.Flush($true);'success'}catch{'failure:'+($_.Exception.GetBaseException().HResult -band 65535)}finally{if($writer){$writer.Dispose()}}";
            string executable=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"WindowsPowerShell","v1.0","powershell.exe");
            var start=new ProcessStartInfo(executable,"-NoLogo -NoProfile -NonInteractive -EncodedCommand "+Convert.ToBase64String(Encoding.Unicode.GetBytes(script)));
            start.UseShellExecute=false;start.CreateNoWindow=true;start.RedirectStandardOutput=true;start.RedirectStandardError=true;
            using(var child=Process.Start(start)) {
                if(!child.WaitForExit(5000)) {child.Kill();child.WaitForExit(5000);return new {status="timed-out-owned-child",output="",error=""};}
                return new {status=child.ExitCode==0?"completed":"failed",output=child.StandardOutput.ReadToEnd().Trim(),error=child.StandardError.ReadToEnd().Trim()};
            }
        }
        static object RenameCase(string root,uint share,bool posix) {
            string dir=Path.Combine(root,"rename-"+share+"-"+posix);Directory.CreateDirectory(dir);
            string target=Path.Combine(dir,"target.txt"),source=Path.Combine(dir,"source.txt");
            File.WriteAllText(target,"original");File.WriteAllText(source,"candidate");
            bool success;int error;string pinned;
            using(var parent=Open(dir,0x80,ShareAll,true))
            using(var targetPin=Open(target,Read,share))
            using(var stage=Open(source,Read|Write|Delete,ShareAll)) {
                byte[] name=Encoding.Unicode.GetBytes("target.txt");
                int offset=(int)Marshal.OffsetOf(typeof(RenameHeader),"FileName"),size=offset+name.Length;
                IntPtr buffer=Marshal.AllocHGlobal(size);
                try {
                    for(int i=0;i<size;i++)Marshal.WriteByte(buffer,i,0);
                    Marshal.WriteInt32(buffer,0,posix?3:1);
                    Marshal.WriteIntPtr(buffer,(int)Marshal.OffsetOf(typeof(RenameHeader),"Root"),parent.DangerousGetHandle());
                    Marshal.WriteInt32(buffer,(int)Marshal.OffsetOf(typeof(RenameHeader),"Length"),name.Length);
                    Marshal.Copy(name,0,IntPtr.Add(buffer,offset),name.Length);
                    IoStatus io;
                    int status=NtSetInformationFile(stage,out io,buffer,(uint)size,posix?65:10);
                    success=status>=0;
                    error=success?0:(int)RtlNtStatusToDosError(status);
                    pinned=ReadPinned(targetPin);
                } finally {Marshal.FreeHGlobal(buffer);}
            }
            return new {share,posix,success,error,pinned,pathBytes=File.ReadAllText(target),sourceExists=File.Exists(source)};
        }
        static object TransactionCase(string root,bool outsideBeforeLock,bool replace) {
            string dir=Path.Combine(root,"tx-"+outsideBeforeLock+"-"+replace);Directory.CreateDirectory(dir);
            string target=Path.Combine(dir,"target.txt"),source=Path.Combine(dir,"source.txt");
            File.WriteAllText(target,"original");File.WriteAllText(source,"candidate");
            using(var tx=CreateTransaction(IntPtr.Zero,IntPtr.Zero,0,0,0,10000,"Nozeli synthetic Windows file diagnostic")) {
                if(tx.IsInvalid)return new {created=false,error=Marshal.GetLastWin32Error()};
                bool committed=false;
                try {
                    string first,lockedBytes;object before=null,after=null;
                    bool locked,moved=false;int lockError,moveError=0,commitError=0;
                    using(var file=CreateFileTransactedW(target,Read|Write|Delete,ShareAll,IntPtr.Zero,Existing,Reparse,IntPtr.Zero,tx,IntPtr.Zero,IntPtr.Zero)) {
                        if(file.IsInvalid)return new {created=true,opened=false,error=Marshal.GetLastWin32Error()};
                        first=ReadPinned(file);
                        if(outsideBeforeLock)before=IndependentWrite(target);
                        uint attributes=(uint)File.GetAttributes(target);
                        uint modified=attributes^0x20;if(modified==0)modified=0x80;
                        locked=SetFileAttributesTransactedW(target,modified,tx);
                        lockError=locked?0:Marshal.GetLastWin32Error();
                        lockedBytes=ReadPinned(file);
                        if(locked)after=IndependentWrite(target);
                    }
                    // This diagnostic records the read/lock ordering. A future
                    // CAS implementation must compare the post-lock version.
                    if(locked&&replace) {
                        moved=MoveFileTransactedW(source,target,IntPtr.Zero,IntPtr.Zero,1,tx);
                        moveError=moved?0:Marshal.GetLastWin32Error();
                        if(moved) {committed=CommitTransaction(tx);commitError=committed?0:Marshal.GetLastWin32Error();}
                    }
                    if(!committed)RollbackTransaction(tx);
                    return new {created=true,opened=true,first,before,locked,lockError,lockedBytes,after,moved,moveError,committed,commitError,
                        pathBytes=File.ReadAllText(target),sourceExists=File.Exists(source)};
                } finally {if(!committed)RollbackTransaction(tx);}
            }
        }
        public static object Run(string root) {
            if(!Directory.Exists(root)||Directory.GetFileSystemEntries(root).Length!=0)
                throw new InvalidOperationException("Expected a fresh, empty synthetic fixture");
            var rename=new List<object>();
            foreach(uint share in new uint[]{1,3,7})foreach(bool posix in new bool[]{false,true})rename.Add(RenameCase(root,share,posix));
            return new {schema=1,synthetic=true,fixture=root,rename,
                transactions=new object[]{TransactionCase(root,true,false),TransactionCase(root,false,true)},
                qualification="observations only; production safe-file and persistence remain unsupported"};
        }
    }
}
