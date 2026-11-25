"""Independent Win32 clipboard oracle. Original payloads stay in memory only.

Line protocol: begin, expect, write, restore. Restore is sequence guarded and
never replaces a newer external clipboard winner. Unsupported handle formats
refuse before any test writes. No original content or format data is emitted.
"""
import ctypes as c
from ctypes import wintypes as w
import json
import sys
import time

assert sys.platform == 'win32'
sys.stdin.reconfigure(encoding='utf-8')
sys.stdout.reconfigure(encoding='utf-8')
user = c.WinDLL('user32', use_last_error=True)
kernel = c.WinDLL('kernel32', use_last_error=True)
gdi = c.WinDLL('gdi32', use_last_error=True)
user.CopyImage.argtypes, user.CopyImage.restype = [w.HANDLE, w.UINT, c.c_int, c.c_int, w.UINT], w.HANDLE
gdi.DeleteObject.argtypes, gdi.DeleteObject.restype = [w.HANDLE], w.BOOL
gdi.CopyEnhMetaFileW.argtypes, gdi.CopyEnhMetaFileW.restype = [w.HANDLE, w.LPCWSTR], w.HANDLE
gdi.DeleteEnhMetaFile.argtypes, gdi.DeleteEnhMetaFile.restype = [w.HANDLE], w.BOOL
for name, args, result in [
    ('OpenClipboard', [w.HWND], w.BOOL), ('CloseClipboard', [], w.BOOL),
    ('EmptyClipboard', [], w.BOOL), ('EnumClipboardFormats', [w.UINT], w.UINT),
    ('GetClipboardData', [w.UINT], w.HANDLE),
    ('SetClipboardData', [w.UINT, w.HANDLE], w.HANDLE),
    ('GetClipboardSequenceNumber', [], w.DWORD),
    ('RegisterClipboardFormatW', [w.LPCWSTR], w.UINT),
    ('CreateWindowExW', [w.DWORD, w.LPCWSTR, w.LPCWSTR, w.DWORD, c.c_int,
                         c.c_int, c.c_int, c.c_int, w.HWND, w.HMENU,
                         w.HINSTANCE, w.LPVOID], w.HWND),
    ('DestroyWindow', [w.HWND], w.BOOL),
]:
    fn = getattr(user, name)
    fn.argtypes, fn.restype = args, result
for name, args, result in [
    ('GlobalSize', [w.HANDLE], c.c_size_t),
    ('GlobalLock', [w.HANDLE], c.c_void_p),
    ('GlobalUnlock', [w.HANDLE], w.BOOL),
    ('GlobalAlloc', [w.UINT, c.c_size_t], w.HANDLE),
    ('GlobalFree', [w.HANDLE], w.HANDLE),
]:
    fn = getattr(kernel, name)
    fn.argtypes, fn.restype = args, result
hwnd = user.CreateWindowExW(0, 'STATIC', 'Nozeli synthetic clipboard oracle',
                            0, 0, 0, 0, 0, w.HWND(-3), None, None, None)
assert hwnd, 'message-only clipboard owner creation failed'
snapshot = None
last_sequence = None


def duplicate_handle(fmt, handle):
    if fmt == 2:  # CF_BITMAP: CopyImage makes an independently owned HBITMAP.
        copied = user.CopyImage(handle, 0, 0, 0, 0x2000)
    elif fmt == 14:  # CF_ENHMETAFILE
        copied = gdi.CopyEnhMetaFileW(handle, None)
    else:
        raise RuntimeError('clipboard handle type cannot be safely duplicated')
    if not copied:
        raise RuntimeError('clipboard native handle duplication failed')
    return copied


def release_snapshot(rows):
    for fmt, data in rows:
        if fmt == 2:
            gdi.DeleteObject(data)
        elif fmt == 14:
            gdi.DeleteEnhMetaFile(data)


def opened():
    deadline = time.monotonic() + 4
    while not user.OpenClipboard(hwnd):
        if time.monotonic() > deadline:
            raise RuntimeError('clipboard busy')
        time.sleep(.025)


def payload(fmt):
    handle = user.GetClipboardData(fmt)
    if not handle:
        raise RuntimeError('clipboard format could not be materialized')
    size = kernel.GlobalSize(handle)
    if not 0 < size <= 16 * 1024 * 1024:
        raise RuntimeError('clipboard contains an unsupported or oversized handle')
    pointer = kernel.GlobalLock(handle)
    if not pointer:
        raise RuntimeError('clipboard global-memory lock failed')
    try:
        return c.string_at(pointer, size)
    finally:
        kernel.GlobalUnlock(handle)


def put(fmt, value):
    handle = kernel.GlobalAlloc(2, len(value))
    if not handle:
        raise RuntimeError('clipboard allocation failed')
    pointer = kernel.GlobalLock(handle)
    if not pointer:
        kernel.GlobalFree(handle)
        raise RuntimeError('clipboard allocation lock failed')
    c.memmove(pointer, value, len(value))
    kernel.GlobalUnlock(handle)
    if not user.SetClipboardData(fmt, handle):
        kernel.GlobalFree(handle)
        raise RuntimeError('clipboard publication failed')


def restore():
    global snapshot, last_sequence
    if snapshot is None:
        return {'restored': False, 'reason': 'no-snapshot'}
    opened()
    try:
        if user.GetClipboardSequenceNumber() != last_sequence:
            return {'restored': False, 'externalWinnerPreserved': True}
        if not user.EmptyClipboard():
            raise RuntimeError('clipboard restore clear failed')
        for fmt, data in snapshot:
            if fmt in (2, 14):
                copied = duplicate_handle(fmt, data)
                if not user.SetClipboardData(fmt, copied):
                    release_snapshot([(fmt, copied)])
                    raise RuntimeError('clipboard handle restore failed')
            else:
                put(fmt, data)
        return {'restored': True, 'formatsRestored': len(snapshot)}
    finally:
        user.CloseClipboard()
        release_snapshot(snapshot)
        snapshot = None


def command(request):
    global snapshot, last_sequence
    action = request['action']
    if action == 'restore':
        return restore()
    opened()
    try:
        if action == 'begin':
            if snapshot is not None:
                raise RuntimeError('snapshot already active')
            rows, fmt, bitmap_derived = [], 0, False
            while True:
                fmt = user.EnumClipboardFormats(fmt)
                if not fmt:
                    break
                # Windows derives CF_BITMAP handles from lossless DIB data.
                # Re-publishing process-local GDI handles alongside DIB/DIBV5
                # can leave invalid handles after their owner exits. Preserve
                # the serialized image and let Windows regenerate its bitmap.
                if fmt == 2 and (user.IsClipboardFormatAvailable(8) or user.IsClipboardFormatAvailable(17)):
                    bitmap_derived = True
                    continue
                if fmt in (3, 9, 0x80, 0x82, 0x83, 0x8E):
                    release_snapshot(rows)
                    raise RuntimeError('non-global clipboard format cannot be safely restored')
                rows.append((fmt, duplicate_handle(fmt, user.GetClipboardData(fmt)) if fmt in (2, 14) else payload(fmt)))
                if len(rows) > 256 or sum(len(data) for kind, data in rows if kind not in (2, 14)) > 64 * 1024 * 1024:
                    release_snapshot(rows)
                    raise RuntimeError('clipboard snapshot exceeds the memory bound')
            snapshot = rows
            last_sequence = user.GetClipboardSequenceNumber()
            return {'snapshotInMemory': True, 'originalContentsLogged': False, 'bitmapDerivedFromPreservedDib': bitmap_derived}
        if snapshot is None:
            raise RuntimeError('begin required before synthetic clipboard work')
        if action == 'expect':
            text = payload(13).decode('utf-16-le').split('\0', 1)[0]
            matches = text == request['expected']
            alternate = text in request.get('alternates', [])
            # Only the exact synthetic winner authorizes restoring later.
            if matches or alternate:
                last_sequence = user.GetClipboardSequenceNumber()
            result = {'matches': matches, 'alternateMatches': alternate,
                      'reader': 'Win32 CF_UNICODETEXT'}
            prefix = request.get('syntheticPrefix', '')
            if len(prefix) >= 36 and text.startswith(prefix):
                result['syntheticReceived'] = text
                last_sequence = user.GetClipboardSequenceNumber()
            return result
        if action == 'expect-files':
            # CF_HDROP is predefined 15, not a registered format of that name.
            try:
                value = payload(15)
            except RuntimeError:
                return {'matches': False, 'reader': 'Win32 CF_HDROP', 'missingNativeFiles': True}
            import struct
            offset, _, _, _, wide = struct.unpack_from('<IiiII', value)
            if offset < 20 or wide != 1:
                raise RuntimeError('synthetic CF_HDROP header invalid')
            names = value[offset:].decode('utf-16-le').split('\0\0', 1)[0].split('\0')
            matches = names == request['expected']
            if matches:
                last_sequence = user.GetClipboardSequenceNumber()
            return {'matches': matches, 'reader': 'Win32 CF_HDROP', 'count': len(names)}
        if action == 'expect-marker':
            fmt = user.RegisterClipboardFormatW('application/x-nozeli-file-clipboard')
            try:
                value = payload(fmt).rstrip(b'\0').decode('utf-8')
            except RuntimeError:
                return {'matches': False, 'reader': 'Win32 private marker'}
            import re
            matches = bool(re.fullmatch('[a-f0-9-]{36}', value))
            if matches:
                last_sequence = user.GetClipboardSequenceNumber()
            return {'matches': matches, 'reader': 'Win32 private marker'}
        if action == 'write-files':
            if user.GetClipboardSequenceNumber() != last_sequence:
                raise RuntimeError('external clipboard winner appeared before synthetic write')
            import struct
            values = request['paths']
            if not values or len(values) > 1024 or any(not isinstance(v, str) or '\0' in v for v in values):
                raise RuntimeError('invalid synthetic file list')
            data = struct.pack('<IiiII', 20, 0, 0, 0, 1) + ('\0'.join(values) + '\0\0').encode('utf-16-le')
            if not user.EmptyClipboard():
                raise RuntimeError('synthetic file clear failed')
            put(15, data)
            effect = user.RegisterClipboardFormatW('Preferred DropEffect')
            put(effect, struct.pack('<I', request.get('effect', 1)))
            last_sequence = user.GetClipboardSequenceNumber()
            return {'syntheticFilesWritten': True, 'count': len(values), 'effect': request.get('effect', 1)}
        if action == 'write':
            # Do not overwrite a new external clipboard winner between checks.
            if user.GetClipboardSequenceNumber() != last_sequence:
                raise RuntimeError('external clipboard winner appeared before synthetic write')
            value = (request['text'] + '\0').encode('utf-16-le')
            if len(value) > 1024 * 1024:
                raise RuntimeError('synthetic clipboard bound exceeded')
            if not user.EmptyClipboard():
                raise RuntimeError('synthetic clipboard clear failed')
            put(13, value)
            last_sequence = user.GetClipboardSequenceNumber()
            return {'syntheticTextWritten': True}
        raise RuntimeError('unknown clipboard action')
    finally:
        user.CloseClipboard()


try:
    for line in sys.stdin:
        try:
            result = {'ok': True, **command(json.loads(line))}
        except Exception as error:
            result = {'ok': False, 'error': str(error)}
        print(json.dumps(result), flush=True)
finally:
    if snapshot is not None:
        restore()
    user.DestroyWindow(hwnd)
