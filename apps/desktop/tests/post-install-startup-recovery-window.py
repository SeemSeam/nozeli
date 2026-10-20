"""KWin observes/cancels only a verified own-PID recovery dialog, never global input."""
import json, os, pathlib, sys, threading, uuid
import dbus, dbus.service
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib
DBusGMainLoop(set_as_default=True)
pid, target_dir, mode = int(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]
assert target_dir.is_dir()
bus = dbus.SessionBus(); loop = GLib.MainLoop()
service = 'org.nozeli.StartupAudit' + uuid.uuid4().hex
name = dbus.service.BusName(service, bus)
result = None
class Receiver(dbus.service.Object):
    @dbus.service.method('org.nozeli.StartupAudit', in_signature='s', out_signature='')
    def Report(self, text):
        global result
        result = json.loads(str(text)); loop.quit()
receiver = Receiver(bus, '/Audit')
plugin = 'nozeli-owned-startup-' + uuid.uuid4().hex
script = target_dir / (plugin + '.js')
# No focus/activate/keyboard calls. Only this exact PID and recovery caption qualify.
script.write_text("const rows=[];for(const w of workspace.windowList()){if(w.pid!=="+str(pid)+")continue;"
    "rows.push({pid:w.pid,caption:w.caption,id:String(w.internalId),dialog:w.dialog});"
    + ("if(w.caption==='工作区恢复')w.closeWindow();" if mode == 'cancel' else '')
    + "}callDBus("+json.dumps(service)+",'/Audit','org.nozeli.StartupAudit','Report',JSON.stringify(rows));")
scripting = dbus.Interface(bus.get_object('org.kde.KWin', '/Scripting'), 'org.kde.kwin.Scripting')
script_id = bus.call_blocking('org.kde.KWin', '/Scripting', 'org.kde.kwin.Scripting', 'loadScript', 'ss', (str(script), plugin))
try:
    obj = dbus.Interface(bus.get_object('org.kde.KWin', '/Scripting/Script'+str(script_id)), 'org.kde.kwin.Script')
    obj.run()
    GLib.timeout_add(5000, lambda: (loop.quit(), False)[1]); loop.run()
finally:
    scripting.unloadScript(plugin)
assert result is not None, 'Own KWin observation timeout'
dialogs = [w for w in result if w['pid']==pid and w['caption']=='工作区恢复']
output = dict(pid=pid, windows=result, action=mode)
assert len(dialogs)==1, 'Expected one exact owned native recovery dialog'
if mode == 'capture':
    read_fd, write_fd = os.pipe(); chunks=[]
    def drain():
        while True:
            data=os.read(read_fd,65536)
            if not data:break
            chunks.append(data)
    reader=threading.Thread(target=drain,daemon=True);reader.start()
    try:
        capture=dbus.Interface(bus.get_object('org.kde.KWin.ScreenShot2','/org/kde/KWin/ScreenShot2'),'org.kde.KWin.ScreenShot2')
        metadata=capture.CaptureWindow(dialogs[0]['id'],dbus.Dictionary({'include-decoration':True},signature='sv'),dbus.types.UnixFd(write_fd),timeout=8)
        os.close(write_fd);write_fd=None;reader.join(5)
        raw=b''.join(chunks);output['capture']={str(k):str(v) for k,v in metadata.items()};output['captureBytes']=len(raw)
        (target_dir/'native-dialog.raw').write_bytes(raw)
        from PIL import Image
        width,height,stride=int(metadata['width']),int(metadata['height']),int(metadata['stride'])
        Image.frombytes('RGBA',(width,height),raw,'raw','BGRA',stride).save(target_dir/'native-dialog.png')
    except Exception as error:
        output['captureError']=str(error)
    finally:
        if write_fd is not None:os.close(write_fd)
        os.close(read_fd)
print(json.dumps(output,ensure_ascii=False))
