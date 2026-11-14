import importlib.metadata as im,json,sys
rows=[]
for d in im.distributions():
 m=d.metadata
 expression=m.get('License-Expression')
 text=m.get('License')
 classifiers=[s for s in m.get_all('Classifier',[]) if s.startswith('License ::')]
 rows.append({'name':m.get('Name'),'version':d.version,'license_expression':expression,'license_metadata_text':text,'license_classifiers':classifiers,'license_files':m.get_all('License-File',[]),'license_unknown':not(expression or text or classifiers),'direct_requirements':d.requires or []})
print(json.dumps(sorted(rows,key=lambda r:r['name'].lower()),ensure_ascii=False,indent=2))
