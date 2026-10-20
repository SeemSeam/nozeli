"""Own-PID native dialog inspection/action. No global pointer/keyboard events."""
import json, os, sys, time
import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi

pid, mode = int(sys.argv[1]), sys.argv[2]
label = sys.argv[3] if len(sys.argv) > 3 else ''
desktop = Atspi.get_desktop(0)
rows, chosen = [], None
def visit(node, depth=0):
    global chosen
    if depth > 12:
        return
    try:
        name, role = node.get_name(), node.get_role_name()
        state = node.get_state_set()
        showing = state.contains(Atspi.StateType.SHOWING)
        if name or role in ('dialog', 'push button'):
            rows.append(dict(name=name, role=role, showing=showing))
        if showing and name == label and role == 'push button':
            chosen = node
        for i in range(node.get_child_count()):
            visit(node.get_child_at_index(i), depth + 1)
    except Exception:
        pass

for i in range(desktop.get_child_count()):
    node = desktop.get_child_at_index(i)
    try:
        if node.get_process_id() == pid:
            visit(node)
    except Exception:
        pass
if mode == 'click':
    if chosen is None:
        print(json.dumps(dict(pid=pid, error='Own visible native button not found', rows=rows), ensure_ascii=False))
        sys.exit(2)
    assert chosen.get_process_id() == pid, 'Native action PID mismatch'
    action = chosen.get_action_iface()
    assert action.get_n_actions() > 0
    ok = action.do_action(0)
    print(json.dumps(dict(pid=pid, label=label, nativeAction=bool(ok), rows=rows), ensure_ascii=False))
    sys.exit(0 if ok else 3)
print(json.dumps(dict(pid=pid, rows=rows), ensure_ascii=False))
