"""Read the real GTK system clipboard; emit only equality with synthetic input."""
import json
import sys
import gi

gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, Gdk, GLib, Gio

expected = json.load(sys.stdin)['expected']
Gtk.init([])
clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
loop = GLib.MainLoop()
matched = False
received = False

def receive(_clipboard, text, _data):
    global matched, received
    received = True
    if text == expected:
        matched = True
        loop.quit()

def request():
    clipboard.request_text(receive, None)
    return True

def finish():
    loop.quit()
    return False

GLib.timeout_add(80, request)
GLib.timeout_add(3500, finish)
request()
loop.run()
manager_matches = None
try:
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    reply = bus.call_sync('org.kde.klipper', '/klipper', 'org.kde.klipper.klipper',
                          'getClipboardContents', None, GLib.VariantType.new('(s)'),
                          Gio.DBusCallFlags.NONE, 500, None)
    manager_matches = reply.unpack()[0] == expected
except GLib.Error:
    pass
print(json.dumps({'matches': matched, 'received': received, 'desktopManagerMatches': manager_matches}))
sys.exit(0 if matched else 1)
