#!/usr/bin/env python3
"""Bitemporal/source-version contract smoke using real isolated SQLite SQL."""
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile

HERE = Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix='nozeli-memory-temporal-') as directory:
    db = sqlite3.connect(str(Path(directory)/'authority.sqlite'))
    db.execute('CREATE TABLE revision(id TEXT, revision INTEGER, body TEXT, source_digest TEXT, source_revision INTEGER, valid_from TEXT, valid_to TEXT, recorded_at TEXT, status TEXT, outcome TEXT, PRIMARY KEY(id,revision))')
    rows = [('k-integrator',1,'欧拉法','2026-01-01','2026-02-01','2026-01-01','confirmed','accept'),
            ('k-integrator',2,'辛积分器','2026-02-01',None,'2026-02-05','verified','discard'),
            ('k-conflict',1,'该条件下方法尚有冲突','2026-02-01',None,'2026-02-06','conflict','unconfirmed')]
    for ident, rev, body, start, end, recorded, status, outcome in rows:
        db.execute('INSERT INTO revision VALUES(?,?,?,?,?,?,?,?,?,?)',(ident,rev,body,hashlib.sha256(body.encode()).hexdigest(),rev,start,end,recorded,status,outcome))
    db.commit()
    def at(valid, recorded, include_conflicts=False):
        statuses=('confirmed','verified','conflict') if include_conflicts else ('confirmed','verified')
        sql='SELECT id,revision,body,status,outcome,source_digest,source_revision FROM revision WHERE valid_from<=? AND (valid_to IS NULL OR valid_to>?) AND recorded_at<=? AND status IN ('+','.join('?' for _ in statuses)+') ORDER BY id,revision'
        return db.execute(sql,(valid,valid,recorded,*statuses)).fetchall()
    cases=[]
    for valid,recorded,conflicts,expected in [
        ('2026-01-15','2026-02-10',False,[('k-integrator',1)]),
        ('2026-02-03','2026-02-04',False,[]),
        ('2026-02-03','2026-02-10',False,[('k-integrator',2)]),
        ('2026-02-03','2026-02-10',True,[('k-conflict',1),('k-integrator',2)])]:
        actual=at(valid,recorded,conflicts)
        assert [(r[0],r[1]) for r in actual]==expected
        cases.append({'validAt':valid,'recordedBefore':recorded,'includeConflicts':conflicts,'rows':actual,'expectedIDsAndRevisions':expected,'exact':True})
    current=at('2026-02-03','2026-02-10')[0]
    assert current[4]=='discard' and current[3]=='verified'
    historical=db.execute('SELECT body,source_revision,source_digest FROM revision WHERE id=? AND revision=?',('k-integrator',1)).fetchone()
    assert historical==('欧拉法',1,hashlib.sha256('欧拉法'.encode()).hexdigest())
    db.close()
report={'scope':'Synthetic real SQLite bitemporal SQL smoke, not production API or semantic extraction','cases':cases,'outcomeDoesNotGateKnowledgeApproval':True,'oldSourceRevisionDigestPreserved':True}
(HERE/'temporal-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'cases':len(cases),'exact':True,'oldSourceRevisionDigestPreserved':True}))
