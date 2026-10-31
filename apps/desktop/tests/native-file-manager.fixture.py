"""Targeted native X11 paste/close for an isolated file-manager smoke window."""
import ctypes as C
import ctypes.util
import sys
x=C.CDLL(ctypes.util.find_library('X11'))
x.XOpenDisplay.argtypes=[C.c_char_p];x.XOpenDisplay.restype=C.c_void_p
d=x.XOpenDisplay(None)
if not d:raise RuntimeError('DISPLAY is required')
x.XDefaultRootWindow.argtypes=[C.c_void_p];x.XDefaultRootWindow.restype=C.c_ulong
root=x.XDefaultRootWindow(d)
class Key(C.Structure):
 _fields_=[('type',C.c_int),('serial',C.c_ulong),('send_event',C.c_int),('display',C.c_void_p),('window',C.c_ulong),('root',C.c_ulong),('subwindow',C.c_ulong),('time',C.c_ulong),('x',C.c_int),('y',C.c_int),('x_root',C.c_int),('y_root',C.c_int),('state',C.c_uint),('keycode',C.c_uint),('same_screen',C.c_int)]
class Data(C.Union):_fields_=[('bytes',C.c_char*20),('longs',C.c_long*5)]
class Client(C.Structure):_fields_=[('type',C.c_int),('serial',C.c_ulong),('send_event',C.c_int),('display',C.c_void_p),('window',C.c_ulong),('message_type',C.c_ulong),('format',C.c_int),('data',Data)]
class Event(C.Union):_fields_=[('key',Key),('client',Client),('pad',C.c_long*24)]
x.XSendEvent.argtypes=[C.c_void_p,C.c_ulong,C.c_int,C.c_long,C.POINTER(Event)]
x.XFlush.argtypes=[C.c_void_p];x.XSetInputFocus.argtypes=[C.c_void_p,C.c_ulong,C.c_int,C.c_ulong]
x.XStringToKeysym.argtypes=[C.c_char_p];x.XStringToKeysym.restype=C.c_ulong
x.XKeysymToKeycode.argtypes=[C.c_void_p,C.c_ulong];x.XKeysymToKeycode.restype=C.c_ubyte
x.XInternAtom.argtypes=[C.c_void_p,C.c_char_p,C.c_int];x.XInternAtom.restype=C.c_ulong
window=int(sys.argv[1],0)
if len(sys.argv)>2 and sys.argv[2]=='close':
 event=Event();event.client.type=33;event.client.display=d;event.client.window=window;event.client.message_type=x.XInternAtom(d,b'WM_PROTOCOLS',False);event.client.format=32;event.client.data.longs[0]=x.XInternAtom(d,b'WM_DELETE_WINDOW',False);assert x.XSendEvent(d,window,False,0,C.byref(event))
else:
 x.XSetInputFocus(d,window,2,0)
 for name,pressed,state in [('Control_L',True,0),('v',True,4),('v',False,4),('Control_L',False,4)]:
  event=Event();event.key=Key(2 if pressed else 3,0,1,d,window,root,0,0,10,10,10,10,state,x.XKeysymToKeycode(d,x.XStringToKeysym(name.encode())),1);assert x.XSendEvent(d,window,False,1 if pressed else 2,C.byref(event))
x.XFlush(d);x.XCloseDisplay.argtypes=[C.c_void_p];x.XCloseDisplay(d)
