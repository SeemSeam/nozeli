import test from 'node:test';import assert from 'node:assert/strict';import {inferTex} from '../src/main/tex-inference.mjs';
const texts=new Map([['a/main.tex','\\documentclass{article}\n\\input{chapter}'],['a/chapter.tex','正文'],['b/main.tex','\\documentclass{article}']]);
const run=extra=>inferTex({texts,current:'a/chapter.tex',config:{root:'',engine:'xelatex'},tools:{xelatex:true,pdflatex:true},...extra});
test('chapter graph selects its own paper and Unicode engine',()=>{const r=run();assert.equal(r.root,'a/main.tex');assert.equal(r.engine,'xelatex');});
test('current main takes precedence and ambiguous file stays unselected',()=>{assert.equal(run({current:'b/main.tex'}).root,'b/main.tex');assert.equal(run({current:'unknown.tex'}).root,'');});
test('saved choices retained and explicit root/program respected',()=>{assert.equal(run({config:{root:'b/main.tex',engine:'lualatex'},hasConfig:true}).engine,'lualatex');const t=new Map(texts);t.set('a/chapter.tex','% !TeX root = ../b/main.tex');t.set('b/main.tex','% !TeX program = lualatex\n\\documentclass{article}');const r=run({texts:t});assert.equal(r.root,'b/main.tex');assert.equal(r.engine,'lualatex');});
test('commented includes and cyclic input do not fabricate ownership',()=>{const t=new Map(texts);t.set('b/main.tex','\\documentclass{article}\n% \\input{../a/chapter}\n\\input{main}');assert.equal(run({texts:t}).root,'a/main.tex');});

test('missing saved main is replaced by current main without changing saved engine',()=>{const r=run({current:'a/main.tex',config:{root:'deleted.tex',engine:'lualatex'},hasConfig:true});assert.equal(r.root,'a/main.tex');assert.equal(r.engine,'lualatex');});
