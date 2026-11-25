// Diagnostic Win32 experiments, not a production filesystem adapter.
// Compiled in memory by Windows-native-probe.ps1; no SDK install is needed.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Nozeli.Diagnostics {
    public static class WindowsFilePrimitives {
        const uint Read = 0x80000000, Write = 0x40000000;
        const uint ShareRead = 1, ShareWrite = 2, ShareDelete = 4;
        const uint Existing = 3, BackupSemantics = 0x02000000, OpenReparsePoint = 0x00200000;

        [StructLayout(LayoutKind.Sequential)]
        struct FileTime { public uint Low, High; }
        [StructLayout(LayoutKind.Sequential)]
        struct FileInformation {
            public uint Attributes;
            public FileTime Creation, Access, Write;
            public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
        }
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError=true)]
        static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation information);
        [DllImport("kernel32.dll", SetLastError=true)]
        static extern bool FlushFileBuffers(SafeFileHandle file);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern bool MoveFileExW(string source, string target, uint flags);

        static SafeFileHandle Open(string path, uint access, uint share, bool directory) {
            var handle=CreateFileW(path,access,share,IntPtr.Zero,Existing,OpenReparsePoint|(directory?BackupSemantics:0),IntPtr.Zero);
            return handle;
        }
        static string Identity(SafeFileHandle handle) {
            FileInformation info;
            if (!GetFileInformationByHandle(handle,out info)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            return info.Volume.ToString("x8")+":"+info.IndexHigh.ToString("x8")+info.IndexLow.ToString("x8");
        }
        static object DirectoryFlush(string directory,uint access) {
            using (var handle=Open(directory,access,ShareRead|ShareWrite|ShareDelete,true)) {
                int openError=handle.IsInvalid?Marshal.GetLastWin32Error():0;
                if (handle.IsInvalid) return new {opened=false,openError,flushed=false,flushError=(int?)null};
                bool flushed=FlushFileBuffers(handle);
                int flushError=flushed?0:Marshal.GetLastWin32Error();
                return new {opened=true,openError,flushed,flushError=(int?)flushError};
            }
        }
        static object Attempt(Action operation) {
            try {operation();return new {succeeded=true,error=0};}
            catch(IOException error) {return new {succeeded=false,error=error.HResult&0xffff};}
            catch(UnauthorizedAccessException error) {return new {succeeded=false,error=error.HResult&0xffff};}
        }
        static string Quote(string value) {return "'"+value.Replace("'","''")+"'";}
        static string CrossProcessAttempt(string operation) {
            // A separate, bounded OS process exercises the kernel's sharing
            // rules. It receives only synthetic paths, with no profile loaded.
            string script="$ErrorActionPreference='Stop';try{"+operation+";'success:0'}catch{'failure:'+($_.Exception.GetBaseException().HResult -band 65535)}";
            string executable=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"WindowsPowerShell","v1.0","powershell.exe");
            var start=new ProcessStartInfo(executable,"-NoLogo -NoProfile -NonInteractive -EncodedCommand "+Convert.ToBase64String(Encoding.Unicode.GetBytes(script)));
            start.UseShellExecute=false;start.CreateNoWindow=true;start.RedirectStandardOutput=true;start.RedirectStandardError=true;
            using(var child=Process.Start(start)) {
                if(!child.WaitForExit(10000)) {child.Kill();child.WaitForExit(5000);throw new TimeoutException("Owned file diagnostic child timed out");}
                string output=child.StandardOutput.ReadToEnd().Trim(),error=child.StandardError.ReadToEnd().Trim();
                if(child.ExitCode!=0||error.Length!=0)throw new InvalidOperationException("File diagnostic child failed: "+error);
                return output;
            }
        }
        static object CrossProcessSharing(string root) {
            string directory=Path.Combine(root,"cross-process"),movedDirectory=Path.Combine(root,"cross-process-moved");
            Directory.CreateDirectory(directory);
            string file=Path.Combine(directory,"guarded.txt"),moved=Path.Combine(directory,"competitor.txt");
            File.WriteAllText(file,"synthetic guarded bytes");
            string parentRename,write,rename;
            using(var parent=Open(directory,Read,ShareRead|ShareWrite,true)) {
                if(parent.IsInvalid)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                parentRename=CrossProcessAttempt("[IO.Directory]::Move("+Quote(directory)+","+Quote(movedDirectory)+")");
            }
            if(Directory.Exists(movedDirectory))Directory.Move(movedDirectory,directory);
            using(var handle=Open(file,Read,ShareRead,false)) {
                if(handle.IsInvalid)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                write=CrossProcessAttempt("[IO.File]::WriteAllText("+Quote(file)+",'synthetic competitor')");
                rename=CrossProcessAttempt("[IO.File]::Move("+Quote(file)+","+Quote(moved)+")");
            }
            if(File.Exists(moved))File.Move(moved,file);
            string whileGuarded=File.ReadAllText(file);
            string afterRelease=CrossProcessAttempt("[IO.File]::WriteAllText("+Quote(file)+",'synthetic after release')");
            return new {parentRename,write,rename,whileGuarded,afterRelease,reopened=File.ReadAllText(file),
                allGuardsBlocked=parentRename=="failure:32"&&write=="failure:32"&&rename=="failure:32",
                limitation="Controlled independent-process attempts; not an adversarial stress test, CAS transaction, or complete anchored path implementation"};
        }
        public static object Run(string root) {
            // The driver creates this unique, empty, synthetic root.
            if (!Directory.Exists(root)||Directory.GetFileSystemEntries(root).Length!=0) throw new InvalidOperationException("Expected a fresh empty fixture");
            var directory=Path.Combine(root,"中文 空格");Directory.CreateDirectory(directory);
            var file=Path.Combine(directory,"source.txt");var moved=Path.Combine(directory,"renamed.txt");
            File.WriteAllText(file,"synthetic original\n",new UTF8Encoding(false));
            string before,after;bool fileFlushed;
            using(var handle=Open(file,Read|Write,ShareRead|ShareWrite|ShareDelete,false)) {
                if(handle.IsInvalid)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                before=Identity(handle);File.Move(file,moved);after=Identity(handle);
                fileFlushed=FlushFileBuffers(handle);
            }
            string reopened;
            using(var handle=Open(moved,Read,ShareRead|ShareWrite|ShareDelete,false))reopened=Identity(handle);
            object parentRename;
            using(var parent=Open(directory,Read,ShareRead|ShareWrite,true)) {
                if(parent.IsInvalid)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                parentRename=Attempt(()=>Directory.Move(directory,Path.Combine(root,"parent-renamed")));
            }
            if(!Directory.Exists(directory))Directory.Move(Path.Combine(root,"parent-renamed"),directory);
            object concurrentWrite,concurrentRename;
            using(var handle=Open(moved,Read,ShareRead,false)) {
                if(handle.IsInvalid)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                concurrentWrite=Attempt(()=>{using(var writer=new FileStream(moved,FileMode.Open,FileAccess.Write,FileShare.ReadWrite|FileShare.Delete))writer.WriteByte(88);});
                concurrentRename=Attempt(()=>File.Move(moved,Path.Combine(directory,"competitor.txt")));
            }
            var replacement=Path.Combine(directory,"replacement.txt");
            var target=Path.Combine(directory,"target.txt");
            File.WriteAllText(replacement,"synthetic replacement\n");File.WriteAllText(target,"synthetic target\n");
            bool published=MoveFileExW(replacement,target,1|8); // REPLACE_EXISTING | WRITE_THROUGH
            int publishError=published?0:Marshal.GetLastWin32Error();
            return new {
                schema=1,probe="nozeli-windows-file-primitives",status="observed",
                fixture=root,synthetic=true,
                identity=new {before,after,reopened,stableAcrossRename=before==after&&before==reopened},
                fileFlush=new {flushed=fileFlushed},
                directoryFlushRead=DirectoryFlush(directory,Read),
                directoryFlushReadWrite=DirectoryFlush(directory,Read|Write),
                sharingGuards=new {parentRename,concurrentWrite,concurrentRename,scope="additional handles in the same process; cross-process and adversarial races remain unqualified"},
                crossProcessSharing=CrossProcessSharing(root),
                writeThroughReplace=new {published,publishError,reopened=File.ReadAllText(target)},
                qualification=new {safeFileIo="unsupported",durablePersistence="unsupported",reason="Primitive observations do not qualify the production contracts, CAS, multi-step transactions, or power-loss durability"}
            };
        }
    }
}
