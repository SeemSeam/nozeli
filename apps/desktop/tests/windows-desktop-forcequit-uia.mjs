// Force-quit-specific Windows fixtures: a Windows UI Automation (UIA) agent
// that drives the product's real native recovery/confirmation dialogs, Win32
// process-tree discovery for owned-descendant pinning, and bounded native
// identity waiters. UIA and CDP gestures are VM automation evidence; they are
// never physical keyboard/mouse/IME/device proof.
import {spawn} from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';

export function windowsPowerShell() {
  const root = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

const encodedCommand = script => Buffer.from(script, 'utf16le').toString('base64');

// Patterns and paths cross the stdin/stdout boundary base64-encoded so a
// console code page can never mangle the native dialog names being matched.
const AGENT_SCRIPT = [
  '$ErrorActionPreference=\'Stop\'',
  'try{[Console]::OutputEncoding=[System.Text.Encoding]::UTF8}catch{}',
  'Add-Type -AssemblyName UIAutomationClient',
  'Add-Type -AssemblyName UIAutomationTypes',
  'Add-Type -AssemblyName System.Drawing',
  'Add-Type -TypeDefinition @\'',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class FqForceQuitWin32 {',
  '  [DllImport("user32.dll", SetLastError=true)]',
  '  public static extern bool PostMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);',
  '  [DllImport("user32.dll", SetLastError=true)]',
  '  public static extern bool SetCursorPos(int x, int y);',
  '  [DllImport("user32.dll")]',
  '  public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);',
  '  [DllImport("user32.dll", SetLastError=true)]',
  '  public static extern bool SetForegroundWindow(IntPtr hWnd);',
  '  [DllImport("user32.dll", SetLastError=true)]',
  '  public static extern IntPtr SetActiveWindow(IntPtr hWnd);',
  '}',
  '\'@',
  '$script:Root=[System.Windows.Automation.AutomationElement]::RootElement',
  'function Reply([object]$payload){',
  '  [Console]::Out.WriteLine(($payload|ConvertTo-Json -Compress -Depth 6))',
  '  [Console]::Out.Flush()',
  '}',
  'function Decode-Arg($args_,[string]$plain,[string]$encoded){',
  '  $direct=$args_.PSObject.Properties[$plain]',
  '  if($direct -and $direct.Value){ return [string]$direct.Value }',
  '  $wrapped=$args_.PSObject.Properties[$encoded]',
  '  if($wrapped -and $wrapped.Value){ return [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$wrapped.Value)) }',
  '  return $null',
  '}',
  'function Get-ChildWindows([int]$ownerPid){',
  '  $condition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty,$ownerPid)',
  '  @($script:Root.FindAll([System.Windows.Automation.TreeScope]::Children,$condition))',
  '}',
  'function Get-WindowByHwnd([int]$ownerPid,[Int64]$wanted){',
  '  foreach($candidate in (Get-ChildWindows $ownerPid)){',
  '    try{ if([Int64]$candidate.Current.NativeWindowHandle -eq $wanted){ return $candidate } }catch{}',
  '  }',
  '  return $null',
  '}',
  'function Wait-Window([int]$ownerPid,[string]$name,[string]$class,[int]$timeoutMs){',
  '  $deadline=[DateTime]::UtcNow.AddMilliseconds($timeoutMs)',
  '  while($true){',
  '    foreach($window in (Get-ChildWindows $ownerPid)){',
  '      try{',
  '        $current=$window.Current',
  '        if($current.Name -like $name -and $current.ClassName -like $class){ return $window }',
  '      }catch{}',
  '    }',
  '    if([DateTime]::UtcNow -ge $deadline){ return $null }',
  '    Start-Sleep -Milliseconds 120',
  '  }',
  '}',
  'function Get-WindowFacts($window){',
  '  $buttons=@(); $named=@()',
  '  try{',
  '    $all=@($window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition))',
  '    foreach($element in $all){',
  '      try{',
  '        $current=$element.Current',
  '        $name=[string]$current.Name',
  '        if(!$name){ continue }',
  '        $kind=[string]$current.ControlType.ProgrammaticName',
  '        if($kind -eq \'ControlType.Button\'){ $buttons += $name }',
  '        if($named.Count -lt 40){ $named += ($kind + \'=\' + $name) }',
  '      }catch{}',
  '    }',
  '  }catch{}',
  '  $current=$window.Current',
  '  @{ name=[string]$current.Name; className=[string]$current.ClassName; hwnd=[Int64]$current.NativeWindowHandle; buttons=$buttons; descendants=$named }',
  '}',
  'function Invoke-ByName($window,[string]$label){',
  '  $candidates=@()',
  '  foreach($element in @($window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition))){',
  '    try{',
  '      $name=[string]$element.Current.Name',
  '      if($name -eq $label){',
  '        $candidates += @{ element=$element; name=$name; kind=[string]$element.Current.ControlType.ProgrammaticName }',
  '      }',
  '    }catch{}',
  '  }',
  '  # Real buttons first, then any element with the exact label. Pattern ids',
  '  # must resolve from the pattern classes (AutomationElement::InvokePattern',
  '  # is null under PowerShell), and some providers expose a named pane with',
  '  # no pattern at all, so the last resort clicks the UIA clickable point.',
  '  $ordered=@($candidates | Where-Object { $_.kind -eq \'ControlType.Button\' }) + @($candidates | Where-Object { $_.kind -ne \'ControlType.Button\' })',
  '  $invokeIdentifier=[System.Windows.Automation.InvokePattern]::Pattern',
  '  foreach($candidate in $ordered){',
  '    try{',
  '      $element=$candidate.element',
  '      try{',
  '        $supported=@($element.GetSupportedPatterns() | Where-Object { $_.Id -eq $invokeIdentifier.Id })',
  '        if($supported.Count){',
  '          $invoke=$element.GetCurrentPattern($invokeIdentifier)',
  '          $invoke.Invoke()',
  '          return @{ clicked=$true; name=$candidate.name; controlType=$candidate.kind; method=\'invokePattern\' }',
  '        }',
  '      }catch{}',
  '      $point=$null',
  '      try{ $point=$element.GetClickablePoint() }catch{}',
  '      if(!$point){',
  '        try{',
  '          $rect=$element.Current.BoundingRectangle',
  '          if($rect.Width -gt 0 -and $rect.Height -gt 0){ $point=New-Object System.Windows.Point(($rect.X + $rect.Width/2), ($rect.Y + $rect.Height/2)) }',
  '        }catch{}',
  '      }',
  '      if($point){',
  '        [FqForceQuitWin32]::SetForegroundWindow([IntPtr]$window.Current.NativeWindowHandle)|Out-Null;[FqForceQuitWin32]::SetActiveWindow([IntPtr]$window.Current.NativeWindowHandle)|Out-Null;[FqForceQuitWin32]::SetCursorPos([int][Math]::Floor($point.X),[int][Math]::Floor($point.Y))|Out-Null',
  '        Start-Sleep -Milliseconds 80',
  '        [FqForceQuitWin32]::mouse_event(0x0002,0,0,0,[UIntPtr]::Zero)',
  '        [FqForceQuitWin32]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero)',
  '        return @{ clicked=$true; name=$candidate.name; controlType=$candidate.kind; method=\'clickablePoint\'; x=[int][Math]::Floor($point.X); y=[int][Math]::Floor($point.Y) }',
  '      }',
  '    }catch{}',
  '  }',
  '  return $null',
  '}',
  'function Save-WindowShot($window,[string]$target){',
  '  try{',
  '    $rect=$window.Current.BoundingRectangle',
  '    $width=[Math]::Max(1,[int][Math]::Ceiling($rect.Width))',
  '    $height=[Math]::Max(1,[int][Math]::Ceiling($rect.Height))',
  '    $bitmap=New-Object System.Drawing.Bitmap($width,$height)',
  '    $graphics=[System.Drawing.Graphics]::FromImage($bitmap)',
  '    try{',
  '      $graphics.CopyFromScreen([int][Math]::Floor($rect.X),[int][Math]::Floor($rect.Y),0,0,(New-Object System.Drawing.Size($width,$height)))',
  '      $bitmap.Save($target,[System.Drawing.Imaging.ImageFormat]::Png)',
  '      return $true',
  '    } finally { $graphics.Dispose(); $bitmap.Dispose() }',
  '  } catch { return $false }',
  '}',
  '$done=$false',
  'while(-not $done){',
  '  $line=[Console]::In.ReadLine()',
  '  if($null -eq $line){ break }',
  '  $text=$line.Trim()',
  '  if(!$text){ continue }',
  '  $identifier=-1',
  '  try{',
  '    $request=$text|ConvertFrom-Json',
  '    $identifier=[int]$request.id',
  '    $response=[ordered]@{ id=$identifier }',
  '    switch([string]$request.cmd){',
  '      ping {',
  '        $response.ok=$true',
  '        $response.pong=$true',
  '      }',
  '      findWindow {',
  '        $name=Decode-Arg $request.args \'name\' \'nameB64\'',
  '        $class=Decode-Arg $request.args \'class\' \'classB64\'',
  '        $window=Wait-Window ([int]$request.args.pid) "$name" "$class" ([int]$request.args.timeoutMs)',
  '        if($window){ $response.ok=$true; $response.found=$true; $response.window=(Get-WindowFacts $window) }',
  '        else{ $response.ok=$true; $response.found=$false }',
  '      }',
  '      listWindows {',
  '        $rows=@()',
  '        foreach($window in (Get-ChildWindows ([int]$request.args.pid))){',
  '          try{ $rows += (Get-WindowFacts $window) }catch{}',
  '        }',
  '        $response.ok=$true',
  '        $response.windows=$rows',
  '      }',
  '      findDialog {',
  '        $name=Decode-Arg $request.args \'name\' \'nameB64\'',
  '        $label=Decode-Arg $request.args \'label\' \'labelB64\'',
  '        $exclude=$request.args.PSObject.Properties[\'excludeHwnd\']',
  '        $deadline=[DateTime]::UtcNow.AddMilliseconds([int]$request.args.timeoutMs)',
  '        $match=$null',
  '        while($true){',
  '          foreach($window in (Get-ChildWindows ([int]$request.args.pid))){',
  '            try{',
  '              $facts=Get-WindowFacts $window',
  '              if($exclude -and [Int64]$facts.hwnd -eq [Int64]$exclude.Value){ continue }',
  '              $labelHit=$false',
  '              if($label){',
  '                foreach($entry in @($facts.descendants)){ if($entry.EndsWith(\'=\' + $label)){ $labelHit=$true; break } }',
  '                foreach($entry in @($facts.buttons)){ if($entry -eq $label){ $labelHit=$true; break } }',
  '              }',
  '              $nameHit=$false',
  '              if($name -and $facts.name -like $name){ $nameHit=$true }',
  '              if(($nameHit -and !$label) -or ($label -and $labelHit)){ $match=$facts; break }',
  '            }catch{}',
  '          }',
  '          if($match -or [DateTime]::UtcNow -ge $deadline){ break }',
  '          Start-Sleep -Milliseconds 150',
  '        }',
  '        if($match){ $response.ok=$true; $response.found=$true; $response.window=$match }',
  '        else{ $response.ok=$true; $response.found=$false }',
  '      }',
  '      clickButton {',
  '        $windowName=Decode-Arg $request.args \'windowName\' \'windowNameB64\'',
  '        $button=Decode-Arg $request.args \'button\' \'buttonB64\'',
  '        $wanted=$request.args.PSObject.Properties[\'hwnd\']',
  '        $deadline=[DateTime]::UtcNow.AddMilliseconds([int]$request.args.timeoutMs)',
  '        $click=$null; $facts=$null',
  '        while($true){',
  '          $window=$null',
  '          if($wanted){ $window=Get-WindowByHwnd ([int]$request.args.pid) ([Int64]$wanted.Value) }',
  '          elseif($windowName){ $window=Wait-Window ([int]$request.args.pid) "$windowName" \'*\' 400 }',
  '          if($window){',
  '            $facts=Get-WindowFacts $window',
  '            $click=Invoke-ByName $window "$button"',
  '            if($click){ break }',
  '          }',
  '          if([DateTime]::UtcNow -ge $deadline){ break }',
  '          Start-Sleep -Milliseconds 100',
  '        }',
  '        if($click){ $response.ok=$true; $response.window=$facts; $response.click=$click }',
  '        else{ $response.ok=$false; $response.error=\'button not found\'; $response.window=$facts }',
  '      }',
  '      closeMainWindow {',
  '        $window=Wait-Window ([int]$request.args.pid) \'*\' \'Chrome_WidgetWin_1\' ([int]$request.args.timeoutMs)',
  '        if(!$window){ $response.ok=$false; $response.error=\'main window not found\' }',
  '        else{',
  '          $method=$null',
  '          $windowIdentifier=[System.Windows.Automation.WindowPattern]::Pattern',
  '          try{',
  '            $supported=@($window.GetSupportedPatterns() | Where-Object { $_.Id -eq $windowIdentifier.Id })',
  '            if($supported.Count){',
  '              $windowPattern=$window.GetCurrentPattern($windowIdentifier)',
  '              $windowPattern.Close()',
  '              $method=\'windowPattern\'',
  '            }',
  '          }catch{}',
  '          if(!$method){',
  '            [FqForceQuitWin32]::PostMessage([IntPtr][Int64]$window.Current.NativeWindowHandle,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)|Out-Null',
  '            $method=\'wmClose\'',
  '          }',
  '          $response.ok=$true',
  '          $response.method=$method',
  '        }',
  '      }',
  '      screenshot {',
  '        $name=Decode-Arg $request.args \'name\' \'nameB64\'',
  '        $class=Decode-Arg $request.args \'class\' \'classB64\'',
  '        $target=Decode-Arg $request.args \'path\' \'pathB64\'',
  '        $wanted=$request.args.PSObject.Properties[\'hwnd\']',
  '        $window=$null',
  '        if($wanted){ $window=Get-WindowByHwnd ([int]$request.args.pid) ([Int64]$wanted.Value) }',
  '        else{ $window=Wait-Window ([int]$request.args.pid) "$name" "$class" ([int]$request.args.timeoutMs) }',
  '        if(!$window){ $response.ok=$false; $response.error=\'window not found\' }',
  '        else{ $response.ok=$true; $response.saved=(Save-WindowShot $window "$target") }',
  '      }',
  '      exit { $response.ok=$true; $done=$true }',
  '      default { $response.ok=$false; $response.error=\'unknown command\' }',
  '    }',
  '    Reply $response',
  '  }catch{',
  '    Reply ([ordered]@{ id=$identifier; ok=$false; error=[string]$_.Exception.Message })',
  '  }',
  '}',
].join('\r\n');

export class UiaAgent {
  constructor() {
    this.pending = new Map();
    this.sequence = 0;
    this.child = null;
    this.closing = false;
    this.exited = null;
    this.diagnostics = '';
  }

  async start() {
    this.child = spawn(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand(AGENT_SCRIPT)], {stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
    this.child.stdin.on('error', () => {});
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', chunk => { this.diagnostics = (this.diagnostics + chunk).slice(-4000); });
    let exitCode = null;
    this.exited = new Promise(resolve => this.child.once('exit', code => {exitCode = code; resolve(code);}));
    const reader = readline.createInterface({input: this.child.stdout});
    reader.on('line', line => {
      if (!line.trim()) return;
      let message;
      try { message = JSON.parse(line); } catch { this.diagnostics = (this.diagnostics + '\nunparsed agent output: ' + line).slice(-4000); return; }
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    });
    // The agent must be a live UIA client before any dialog can be driven.
    try {
      await this.call('ping', {}, 45000);
    } catch (error) {
      await new Promise(resolve => setTimeout(resolve, 250));
      const detail = exitCode === null ? 'still running without answering' : 'exited with code ' + exitCode;
      // A failed startup must never leak a pipe-holding agent process: the
      // abandoned PowerShell would keep the driver's event loop alive.
      if (exitCode === null) this.child.kill();
      for (const {resolve: settle} of this.pending.values()) settle({ok: false, error: 'agent startup failed'});
      this.pending.clear();
      throw Object.assign(new Error('UIA agent startup failed (' + detail + '): ' + (this.diagnostics || 'no stderr').slice(-1500)), {code: error.code, cause: error});
    }
    return this;
  }

  call(cmd, args = {}, timeoutMs = 20000) {
    if (!this.child || this.closing) return Promise.reject(Object.assign(new Error('UIA agent is not running'), {code: 'UIA_AGENT_STOPPED'}));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error('UIA command timed out: ' + cmd), {code: 'UIA_TIMEOUT', cmd}));
      }, timeoutMs);
      this.pending.set(id, {resolve, timer});
      this.child.stdin.write(JSON.stringify({id, cmd, args}) + '\n', error => {
        if (error) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  findWindow({pid, name = '*', className = '*', timeoutMs = 5000}) {
    return this.call('findWindow', {pid, timeoutMs, nameB64: Buffer.from(name, 'utf8').toString('base64'), classB64: Buffer.from(className, 'utf8').toString('base64')}, timeoutMs + 10000);
  }

  listWindows({pid, timeoutMs = 5000}) {
    return this.call('listWindows', {pid}, timeoutMs + 10000);
  }

  // Content-based dialog discovery: some providers never expose the window
  // title, so the dialog is identified by a labeled control it contains.
  findDialog({pid, label = null, name = null, excludeHwnd = null, timeoutMs = 15000}) {
    const args = {pid, timeoutMs};
    if (label) args.labelB64 = Buffer.from(label, 'utf8').toString('base64');
    if (name) args.nameB64 = Buffer.from(name, 'utf8').toString('base64');
    if (Number.isInteger(excludeHwnd)) args.excludeHwnd = excludeHwnd;
    return this.call('findDialog', args, timeoutMs + 10000);
  }

  clickButton({pid, windowName = null, hwnd = null, button, timeoutMs = 15000}) {
    const args = {pid, timeoutMs, buttonB64: Buffer.from(button, 'utf8').toString('base64')};
    if (windowName) args.windowNameB64 = Buffer.from(windowName, 'utf8').toString('base64');
    if (Number.isInteger(hwnd)) args.hwnd = hwnd;
    return this.call('clickButton', args, timeoutMs + 10000);
  }

  closeMainWindow({pid, timeoutMs = 10000}) {
    return this.call('closeMainWindow', {pid, timeoutMs}, timeoutMs + 10000);
  }

  screenshotWindow({pid, name = '*', className = '*', hwnd = null, file, timeoutMs = 5000}) {
    const args = {pid, timeoutMs, nameB64: Buffer.from(name, 'utf8').toString('base64'), classB64: Buffer.from(className, 'utf8').toString('base64'), pathB64: Buffer.from(path.resolve(file), 'utf8').toString('base64')};
    if (Number.isInteger(hwnd)) args.hwnd = hwnd;
    return this.call('screenshot', args, timeoutMs + 10000);
  }

  async dispose() {
    this.closing = true;
    try { await this.call('exit', {}, 2000); } catch { /* the agent may already be gone */ }
    for (const {resolve} of this.pending.values()) resolve({ok: false, error: 'agent disposed'});
    this.pending.clear();
    this.child?.kill();
    await Promise.race([this.exited ?? Promise.resolve(), new Promise(resolve => setTimeout(resolve, 2000))]);
  }
}

const LIST_SCRIPT = [
  '$ErrorActionPreference=\'Stop\'',
  'try{[Console]::OutputEncoding=[System.Text.Encoding]::UTF8}catch{}',
  '$rows=Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate,ExecutablePath,CommandLine',
  '$data=@()',
  'foreach($row in $rows){',
  '  $data += [ordered]@{ pid=[uint32]$row.ProcessId; parent=[uint32]$row.ParentProcessId; name=[string]$row.Name; creation=$row.CreationDate; image=$row.ExecutablePath; command=$row.CommandLine }',
  '}',
  '[Console]::Out.WriteLine(($data|ConvertTo-Json -Compress -Depth 3))',
].join('\r\n');

// Discovery only. Signalling authority never comes from this listing: every
// exit observation is made through a pinned native process identity HANDLE.
export async function listProcessRows() {
  const child = spawn(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand(LIST_SCRIPT)], {stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true});
  let text = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { text += chunk; });
  const [code] = await Promise.all([
    new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }),
    new Promise(resolve => child.stdout.once('end', resolve)),
  ]);
  if (code !== 0) throw Object.assign(new Error('process listing failed: exit ' + code), {code: 'PROCESS_LIST_FAILED'});
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

export function creationTo100ns(value) {
  if (typeof value !== 'string') return null;
  const epoch = /\/Date\((\d+)/.exec(value);
  if (epoch) return Number(epoch[1]) * 10000 + 116444736000000000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed * 10000 + 116444736000000000 : null;
}

export async function pinProcessTree(native, rootPid, {excludeImages = []} = {}) {
  const rows = await listProcessRows();
  const byParent = new Map();
  for (const row of rows) {
    if (!Number.isInteger(row.pid) || !Number.isInteger(row.parent)) continue;
    const list = byParent.get(row.parent) ?? [];
    list.push(row);
    byParent.set(row.parent, list);
  }
  const descendants = [];
  const seen = new Set([rootPid]);
  const walk = parent => {
    for (const row of byParent.get(parent) ?? []) {
      if (seen.has(row.pid)) continue;
      seen.add(row.pid);
      descendants.push(row);
      walk(row.pid);
    }
  };
  walk(rootPid);
  const excluded = new Set(excludeImages.filter(Boolean).map(value => String(value).toLowerCase()));
  const pinned = [], browserManaged = [], vanished = [];
  for (const row of descendants) {
    const image = String(row.image ?? '');
    // Chromium children that share the Electron image are browser-managed: the
    // native force-quit capture deliberately skips them and app.exit(0) tears
    // them down with the browser, so they are recorded but never claimed.
    if (excluded.has(image.toLowerCase())) { browserManaged.push({pid: row.pid, name: row.name, image}); continue; }
    try {
      const pin = native.openProcessIdentity(row.pid);
      const snapshot = pin.snapshot();
      pinned.push({row, pin, stamp: snapshot.stamp, imagePath: snapshot.imagePath, discoveredCreation: creationTo100ns(row.creation)});
    } catch (error) {
      vanished.push({pid: row.pid, name: row.name, code: error.code ?? String(error.message ?? error)});
    }
  }
  return {rows: descendants, pinned, browserManaged, vanished};
}

export async function waitForExited(pin, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // snapshot() throws PROCESS_IDENTITY_CHANGED if the PID was reused; a
    // reused PID is never accepted as the original process exiting.
    const snapshot = pin.snapshot();
    if (snapshot.state === 'exited') return snapshot;
    if (Date.now() >= deadline) throw new Error('Timed out waiting for pinned native identity exit: ' + label);
    await new Promise(resolve => setTimeout(resolve, 60));
  }
}

export async function assertRunning(pin, label) {
  const snapshot = pin.snapshot();
  if (snapshot.state !== 'running') throw new Error(label + ' must still be running through its pinned native identity');
  return snapshot;
}
