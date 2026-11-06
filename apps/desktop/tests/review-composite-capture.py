"""Select only the verified owned parent through Spectacle's normal region UI.

Usage: python3 review-composite-capture.py PID OUTPUT.png BOUNDS_JSON
Requires dbus-python, PyGObject, Pillow, Spectacle, libX11 and libXtst. The
single-output mapping and Spectacle active PID are mandatory. Right-drag
starts a fresh selection regardless of the remembered rectangle; Spectacle's
inclusive endpoint is accounted for. Focus recovery is bounded and never
relaxes the exact-PID input gate. No screenshot permissions/configuration,
clipboard, full-screen files or image stitching.
"""
import ctypes
import ctypes.util
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

import dbus
import dbus.service
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib
from PIL import Image

pid, output, bounds = int(sys.argv[1]), Path(sys.argv[2]), json.loads(sys.argv[3])
assert pid > 0 and output.parent.is_dir()
assert set(bounds) == {'x', 'y', 'width', 'height'}
assert all(type(value) is int for value in bounds.values())
assert bounds['width'] > 0 and bounds['height'] > 0
DBusGMainLoop(set_as_default=True)
bus = dbus.SessionBus()
loop = GLib.MainLoop()
service = 'org.nozeli.ReviewCapture' + uuid.uuid4().hex
name = dbus.service.BusName(service, bus)
result = None


class Receiver(dbus.service.Object):
    @dbus.service.method('org.nozeli.ReviewCapture', in_signature='s', out_signature='')
    def Report(self, text):
        global result
        result = json.loads(str(text))
        loop.quit()


receiver = Receiver(bus, '/Capture')
scripting = dbus.Interface(bus.get_object('org.kde.KWin', '/Scripting'), 'org.kde.kwin.Scripting')


def kwin_query(source):
    global result
    result = None
    plugin = 'nozeli-review-region-' + uuid.uuid4().hex
    script = output.parent / (plugin + '.js')
    script.write_text(source + '\ncallDBus(' + json.dumps(service) +
                      ',"/Capture","org.nozeli.ReviewCapture","Report",JSON.stringify(answer));')
    timer = None
    try:
        script_id = bus.call_blocking('org.kde.KWin', '/Scripting', 'org.kde.kwin.Scripting', 'loadScript', 'ss', (str(script), plugin))
        obj = dbus.Interface(bus.get_object('org.kde.KWin', '/Scripting/Script' + str(script_id)), 'org.kde.kwin.Script')
        obj.run()
        timer = GLib.timeout_add(5000, lambda: (loop.quit(), False)[1])
        loop.run()
        assert result is not None, 'Own KWin region observation timed out'
        return result
    finally:
        if timer is not None and result is not None:
            GLib.source_remove(timer)
        scripting.unloadScript(plugin)
        script.unlink(missing_ok=True)


activation = kwin_query(
    'const bounds=' + json.dumps(bounds) + ';const rows=[];const matches=[];'
    'for(const w of workspace.windowList()){if(w.pid!==' + str(pid) + ')continue;'
    'const r=w.frameGeometry;const row={pid:w.pid,id:String(w.internalId),'
    'bounds:{x:r.x,y:r.y,width:r.width,height:r.height}};rows.push(row);'
    'if(["x","y","width","height"].every(k=>Math.abs(row.bounds[k]-bounds[k])<=2))matches.push(w);}'
    'if(matches.length===1)workspace.activeWindow=matches[0];'
    'const outputs=Array.from(workspace.screens||workspace.outputs||[]).map(o=>'
    '({name:o.name,scale:o.scale,geometry:{x:o.geometry.x,y:o.geometry.y,width:o.geometry.width,height:o.geometry.height}}));'
    'const answer={windows:rows,matches:matches.length,outputs,'
    'activated:matches.length===1?String(matches[0].internalId):null};')
assert activation['matches'] == 1, 'Expected one exact own-PID parent geometry: ' + str(activation)
assert len(activation['outputs']) == 1, 'Automatic region selection requires one known output; multi-output layouts are not supported'
screen = activation['outputs'][0]
geometry, scale = screen['geometry'], screen.get('scale')
assert all(isinstance(geometry.get(key), (int, float)) for key in ('x', 'y', 'width', 'height'))
assert geometry['width'] > 0 and geometry['height'] > 0
assert bounds['x'] >= geometry['x'] and bounds['y'] >= geometry['y'] and bounds['x'] + bounds['width'] <= geometry['x'] + geometry['width'] and bounds['y'] + bounds['height'] <= geometry['y'] + geometry['height'], 'Exact owned parent is partly off-output; cannot select or claim unseen pixels'
time.sleep(0.25)
active = kwin_query('const w=workspace.activeWindow;const answer={pid:w?.pid,id:w?String(w.internalId):null};')
assert active['pid'] == pid and active['id'] == activation['activated'], 'Exact owned parent did not become active'

x11 = ctypes.CDLL(ctypes.util.find_library('X11') or 'libX11.so.6')
xtst = ctypes.CDLL(ctypes.util.find_library('Xtst') or 'libXtst.so.6')
Display, Window = ctypes.c_void_p, ctypes.c_ulong
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XOpenDisplay.restype = Display
x11.XDefaultScreen.argtypes = [Display]
x11.XDefaultScreen.restype = ctypes.c_int
x11.XRootWindow.argtypes = [Display, ctypes.c_int]
x11.XRootWindow.restype = Window
for function in (x11.XDisplayWidth, x11.XDisplayHeight):
    function.argtypes = [Display, ctypes.c_int]
    function.restype = ctypes.c_int
x11.XInternAtom.argtypes = [Display, ctypes.c_char_p, ctypes.c_int]
x11.XInternAtom.restype = ctypes.c_ulong
x11.XGetWindowProperty.argtypes = [Display, Window, ctypes.c_ulong, ctypes.c_long, ctypes.c_long, ctypes.c_int, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.POINTER(ctypes.c_ubyte))]
x11.XGetWindowProperty.restype = ctypes.c_int
x11.XFree.argtypes = [ctypes.c_void_p]
x11.XSync.argtypes = [Display, ctypes.c_int]
x11.XCloseDisplay.argtypes = [Display]
x11.XStringToKeysym.argtypes = [ctypes.c_char_p]
x11.XStringToKeysym.restype = ctypes.c_ulong
x11.XKeysymToKeycode.argtypes = [Display, ctypes.c_ulong]
x11.XKeysymToKeycode.restype = ctypes.c_ubyte
xtst.XTestFakeMotionEvent.argtypes = [Display, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
xtst.XTestFakeButtonEvent.argtypes = [Display, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
xtst.XTestFakeKeyEvent.argtypes = [Display, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
display = x11.XOpenDisplay(None)
assert display, 'X11 display is required for the scoped Spectacle selection UI'
x11.XGetInputFocus.argtypes = [Display, ctypes.POINTER(Window), ctypes.POINTER(ctypes.c_int)]
x11.XQueryTree.argtypes = [Display, Window, ctypes.POINTER(Window), ctypes.POINTER(Window), ctypes.POINTER(ctypes.POINTER(Window)), ctypes.POINTER(ctypes.c_uint)]


def property_value(window, name):
    atom = x11.XInternAtom(display, name.encode(), False)
    actual, fmt, count, remaining = ctypes.c_ulong(), ctypes.c_int(), ctypes.c_ulong(), ctypes.c_ulong()
    data = ctypes.POINTER(ctypes.c_ubyte)()
    status = x11.XGetWindowProperty(display, window, atom, 0, 1, False, 0,
                                    ctypes.byref(actual), ctypes.byref(fmt), ctypes.byref(count), ctypes.byref(remaining), ctypes.byref(data))
    try:
        if status != 0 or fmt.value != 32 or count.value != 1 or not data:
            return None
        return ctypes.cast(data, ctypes.POINTER(ctypes.c_ulong))[0]
    finally:
        if data:
            x11.XFree(data)


try:
    screen_number = x11.XDefaultScreen(display)
    root = x11.XRootWindow(display, screen_number)
    root_width, root_height = x11.XDisplayWidth(display, screen_number), x11.XDisplayHeight(display, screen_number)
    scale_x, scale_y = root_width / geometry['width'], root_height / geometry['height']
    assert abs(scale_x - scale_y) * max(geometry['width'], geometry['height']) <= 2, 'Single-output X11 pixel scales disagree; refusing selection'
    if isinstance(scale, (int, float)) and math.isfinite(scale) and scale > 0:
        assert abs(root_width - geometry['width'] * scale) <= 2 and abs(root_height - geometry['height'] * scale) <= 2, 'KWin scale does not match actual X11 display pixels'
        scale_source = 'KWin output scale, checked against actual X11 root geometry'
    else:
        scale_source = 'derived from actual X11 root pixels / single KWin output logical geometry'
    screen['pixelMapping'] = {'x': scale_x, 'y': scale_y, 'source': scale_source}
    left = round((bounds['x'] - geometry['x']) * scale_x)
    top = round((bounds['y'] - geometry['y']) * scale_y)
    width, height = round(bounds['width'] * scale_x), round(bounds['height'] * scale_y)
    # Spectacle 6.6 SelectionEditor includes the final device pixel.
    right, bottom = left + width - 1, top + height - 1
    assert 0 <= left < right < root_width and 0 <= top < bottom < root_height, 'Exact region endpoints must be reachable within the single output'
    enter = x11.XKeysymToKeycode(display, x11.XStringToKeysym(b'Return'))
    assert enter, 'Return key is unavailable'
    frames_dir = output.parent / (output.stem + '-compositor-frames')
    frames_dir.mkdir(exist_ok=True)
    frames = []
    for index in range(12):
        # Re-activate only the previously verified own parent before the tool
        # takes its preview. No unrelated application is focused or captured.
        restored = kwin_query('const wanted=' + json.dumps(activation['activated']) + ';let found=null;'
                              'for(const w of workspace.windowList())if(w.pid===' + str(pid) + '&&String(w.internalId)===wanted)found=w;'
                              'if(found)workspace.activeWindow=found;const active=workspace.activeWindow;'
                              'const answer={found:!!found,activePid:active?.pid,activeId:active?String(active.internalId):null};')
        assert restored['found'] and restored['activePid'] == pid and restored['activeId'] == activation['activated'], 'Exact owned parent was not activated before region preview'
        time.sleep(0.15)
        started = time.monotonic()
        frame = frames_dir / f'{index:03d}.png'
        frame.unlink(missing_ok=True)
        env = {**os.environ, 'QT_QPA_PLATFORM': 'xcb'}
        proc = subprocess.Popen(['spectacle', '--new-instance', '--background', '--region', '--nonotify', '--output', str(frame)], env=env,
                                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

        ownership = {}
        button_down = False
        ownership_trace = []

        def is_tool_active():
            window = property_value(root, '_NET_ACTIVE_WINDOW')
            active_pid = property_value(window, '_NET_WM_PID') if window else None
            focus, revert = Window(), ctypes.c_int()
            x11.XGetInputFocus(display, ctypes.byref(focus), ctypes.byref(revert))
            focus_pid, chain, current = None, [], focus.value
            for _ in range(32):
                if not current or current == 1:
                    break
                candidate = property_value(current, '_NET_WM_PID')
                chain.append({'id': current, 'pid': candidate})
                if candidate is not None:
                    focus_pid = candidate
                    break
                tree_root, parent, children, count = Window(), Window(), ctypes.POINTER(Window)(), ctypes.c_uint()
                status = x11.XQueryTree(display, current, ctypes.byref(tree_root), ctypes.byref(parent), ctypes.byref(children), ctypes.byref(count))
                if children:
                    x11.XFree(children)
                if not status or parent.value == current:
                    break
                current = parent.value
            ownership.update(activeWindow=window, activePid=active_pid, focusChain=chain, focusPid=focus_pid, processAlive=proc.poll() is None)
            ownership_trace.append(dict(ownership))
            if proc.poll() is not None:
                return False
            if active_pid == proc.pid and focus_pid == proc.pid:
                return True
            if focus_pid != proc.pid:
                return False
            overlay = kwin_query('const rows=[];for(const w of workspace.windowList())if(w.pid===' + str(proc.pid) + ')rows.push({pid:w.pid,id:String(w.internalId)});const answer={windows:rows};')
            ownership['kwinOverlay'] = overlay
            return bool(overlay['windows'])

        def inject(function, *arguments):
            deadline = time.monotonic() + 2
            while not is_tool_active() and proc.poll() is None and time.monotonic() < deadline:
                time.sleep(0.05)
            assert is_tool_active(), 'Spectacle lost exact-PID active/focus ownership; refusing XTest input: ' + json.dumps(ownership)
            assert function(display, *arguments, 0), 'XTest input was not accepted'
            x11.XSync(display, False)

        try:
            deadline = time.monotonic() + 12
            while not is_tool_active():
                assert proc.poll() is None and time.monotonic() < deadline, 'Exact Spectacle process never acquired the active X11 selection window'
                time.sleep(0.05)
            time.sleep(0.25)
            inject(xtst.XTestFakeMotionEvent, screen_number, left, top)
            time.sleep(0.1)
            # Right-drag clears any remembered selection in the normal UI,
            # then creates a fresh rectangle. A right-click alone is unsafe:
            # release-to-capture could accept an empty (whole-screen) region.
            inject(xtst.XTestFakeButtonEvent, 3, True)
            button_down = True
            time.sleep(0.1)
            for step in range(1, 17):
                inject(xtst.XTestFakeMotionEvent, screen_number, round(left + (width - 1) * step / 16), round(top + (height - 1) * step / 16))
                time.sleep(0.03)
            inject(xtst.XTestFakeButtonEvent, 3, False)
            button_down = False
            time.sleep(0.1)
            # Queue the complete key pair while the verified tool owns focus;
            # syncing between press/release could let capture close the UI.
            if proc.poll() is None and is_tool_active():
                assert xtst.XTestFakeKeyEvent(display, enter, True, 0)
                assert xtst.XTestFakeKeyEvent(display, enter, False, 0)
                x11.XSync(display, False)
            _, stderr = proc.communicate(timeout=15)
            assert proc.returncode == 0, 'Spectacle region capture failed: ' + stderr.decode(errors='replace')
        finally:
            if button_down:
                # A matching release is mandatory even if focus changed. It
                # creates no new press and cannot leave the user's mouse held.
                xtst.XTestFakeButtonEvent(display, 3, False, 0)
                x11.XSync(display, False)
                button_down = False
            if proc.poll() is None:
                is_tool_active()
                output.with_suffix('.capture-failure.json').write_text(json.dumps({'toolPid': proc.pid, 'ownership': ownership, 'trace': ownership_trace, 'areaDip': bounds, 'output': screen}, indent=2))
                proc.terminate()
                try:
                    proc.communicate(timeout=3)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.communicate()
        assert frame.is_file(), 'Spectacle did not save the selected parent region'
        with Image.open(frame) as captured:
            image = captured.convert('RGBA')
        assert image.size == (width, height), 'Selected image does not exactly match requested parent DIP dimensions and output scale: ' + str(image.size)
        assert any(high > low for low, high in image.convert('RGB').getextrema()), 'Spectacle returned a blank region; not valid overlay evidence'
        # Preserve the actual selected-region file, without re-encoding or
        # constructing a synthetic parent/child composite.
        output.write_bytes(frame.read_bytes())
        frames.append({'file': str(frame), 'elapsedSeconds': time.monotonic() - started, 'width': width, 'height': height, 'bytes': frame.stat().st_size, 'spectaclePid': proc.pid})
    evidence = {'pid': pid, 'areaDip': bounds, 'activation': activation, 'output': screen,
                'selectionPixels': {'x': left, 'y': top, 'width': width, 'height': height},
                'x11RootPixels': {'width': root_width, 'height': root_height},
                'frames': frames, 'width': width, 'height': height, 'framesDirectory': str(frames_dir),
                'capture': 'spectacle --new-instance --background --region --nonotify; exact-PID XTest selection',
                'ownedChildIncluded': 'requires child-region pixel verification in the journey'}
    output.with_suffix('.capture.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2))
    print(json.dumps(evidence, ensure_ascii=False))
finally:
    x11.XCloseDisplay(display)
