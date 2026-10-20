"""Optional XWayland native-dialog test: events/images target exact owned XID only."""
import ctypes as C, ctypes.util, json, os, pathlib, subprocess, sys, time
pid, expected_start, target_dir, label = int(sys.argv[1]), sys.argv[2], pathlib.Path(sys.argv[3]), sys.argv[4]
def stamp():
    return pathlib.Path('/proc/'+str(pid)+'/stat').read_text().rsplit(')',1)[1].split()[19]
assert stamp()==expected_start, 'Owned main stamp changed'
lib=C.CDLL(ctypes.util.find_library('X11'))
lib.XOpenDisplay.restype=C.c_void_p;lib.XOpenDisplay.argtypes=[C.c_char_p]
display=lib.XOpenDisplay(None);assert display, 'Own XWayland display unavailable'
lib.XDefaultRootWindow.argtypes=[C.c_void_p];lib.XDefaultRootWindow.restype=C.c_ulong
root=lib.XDefaultRootWindow(display)
lib.XInternAtom.argtypes=[C.c_void_p,C.c_char_p,C.c_int];lib.XInternAtom.restype=C.c_ulong
lib.XGetWindowProperty.argtypes=[C.c_void_p,C.c_ulong,C.c_ulong,C.c_long,C.c_long,C.c_int,C.c_ulong,C.POINTER(C.c_ulong),C.POINTER(C.c_int),C.POINTER(C.c_ulong),C.POINTER(C.c_ulong),C.POINTER(C.POINTER(C.c_ubyte))]
lib.XQueryTree.argtypes=[C.c_void_p,C.c_ulong,C.POINTER(C.c_ulong),C.POINTER(C.c_ulong),C.POINTER(C.POINTER(C.c_ulong)),C.POINTER(C.c_uint)]
lib.XFree.argtypes=[C.c_void_p]
def prop(w,name):
    atom=lib.XInternAtom(display,name.encode(),0);kind=C.c_ulong();fmt=C.c_int();n=C.c_ulong();after=C.c_ulong();data=C.POINTER(C.c_ubyte)()
    lib.XGetWindowProperty(display,w,atom,0,4096,0,0,C.byref(kind),C.byref(fmt),C.byref(n),C.byref(after),C.byref(data))
    if not data:return None
    try:
        if fmt.value==32:return [C.cast(data,C.POINTER(C.c_ulong))[i] for i in range(n.value)]
        if fmt.value==8:return C.string_at(data,n.value).decode(errors='replace')
        return None
    finally:lib.XFree(data)
r=C.c_ulong();parent=C.c_ulong();children=C.POINTER(C.c_ulong)();n=C.c_uint()
lib.XQueryTree(display,root,C.byref(r),C.byref(parent),C.byref(children),C.byref(n))
caption='确认重新加载' if label in ('取消','确认重新加载') else '工作区恢复'
matches=[]
try:
    for wid in (prop(root,'_NET_CLIENT_LIST') or [children[i] for i in range(n.value)]):
        if prop(wid,'_NET_WM_PID')==[pid] and prop(wid,'_NET_WM_NAME')==caption:matches.append(wid)
finally:lib.XFree(children)
assert len(matches)==1, 'Expected one exact own native XWayland recovery dialog'
wid=matches[0];assert stamp()==expected_start
# ImageMagick reads this window only; never active window, screen, selection or clipboard.
shot=target_dir/('native-'+('confirmation' if caption=='确认重新加载' else 'recovery')+'.png')
subprocess.run(['/usr/bin/import','-window',hex(wid),str(shot)],check=True,timeout=8)
class Key(C.Structure):
    _fields_=[('type',C.c_int),('serial',C.c_ulong),('send_event',C.c_int),('display',C.c_void_p),('window',C.c_ulong),('root',C.c_ulong),('subwindow',C.c_ulong),('time',C.c_ulong),('x',C.c_int),('y',C.c_int),('x_root',C.c_int),('y_root',C.c_int),('state',C.c_uint),('keycode',C.c_uint),('same_screen',C.c_int)]
class Event(C.Union):_fields_=[('key',Key),('pad',C.c_long*24)]
lib.XKeysymToKeycode.argtypes=[C.c_void_p,C.c_ulong];lib.XKeysymToKeycode.restype=C.c_uint
lib.XSendEvent.argtypes=[C.c_void_p,C.c_ulong,C.c_int,C.c_long,C.POINTER(Event)]
lib.XSync.argtypes=[C.c_void_p,C.c_int]
def key(symbol):
    assert stamp()==expected_start and prop(wid,'_NET_WM_PID')==[pid]
    for event_type in (2,3):
        event=Event();event.key=Key(type=event_type,display=display,window=wid,root=root,keycode=lib.XKeysymToKeycode(display,symbol),same_screen=1)
        assert lib.XSendEvent(display,wid,0,1<<(event_type-2),C.byref(event))
    lib.XSync(display,0);time.sleep(.1)
if label in ('重新加载工作区…','确认重新加载'):key(0xff09)
key(0xff0d)
print(json.dumps(dict(pid=pid,start=expected_start,xid=hex(wid),caption=caption,label=label,mode='native-targeted-XSendEvent-Tab-Return',screenshot=str(shot)),ensure_ascii=False))
