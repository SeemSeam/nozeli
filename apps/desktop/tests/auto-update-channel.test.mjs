import test from 'node:test';
import assert from 'node:assert/strict';
import {selectRelease} from '../src/main/auto-update.mjs';
const release=(version,{prerelease=false,platform='windows-x64.zip'}={})=>({tag_name:'v'+version,prerelease,assets:[{name:'Nozeli-'+version+'-'+platform,size:100,browser_download_url:'https://github.com/SeemSeam/nozeli/releases/download/v'+version+'/package'},{name:'SHA256SUMS.txt',size:100,browser_download_url:'https://github.com/SeemSeam/nozeli/releases/download/v'+version+'/SHA256SUMS.txt'}]});
test('stable Windows channel excludes prerelease tags and flagged releases while selecting only x64 ZIP',()=>{
 const feed=[release('2.0.0-beta.1'),release('1.5.0',{prerelease:true}),release('1.4.0',{platform:'linux-x64.tar.gz'}),release('1.3.0',{platform:'windows-arm64.zip'}),release('1.2.0')];
 assert.equal(selectRelease(feed,'1.0.0','win32','x64').version,'1.2.0');
 assert.equal(selectRelease(feed.slice(0,4),'1.0.0','win32','x64'),null);
 assert.equal(selectRelease(feed,'1.0.0','win32','arm64'),null);
});
test('prerelease clients retain explicit prerelease progression without changing stable Linux or Mac policy',()=>{
 assert.equal(selectRelease([release('2.0.0-beta.2'),release('1.2.0')],'2.0.0-beta.1','win32','x64').version,'2.0.0-beta.2');
 for(const [platform,arch,suffix] of [['linux','x64','linux-x64.tar.gz'],['darwin','arm64','macos-arm64.zip']]){
  const feed=[release('3.0.0-beta.1',{platform:suffix}),release('2.0.0',{platform:suffix})];
  assert.equal(selectRelease(feed,'1.0.0',platform,arch).version,'2.0.0');
 }
});
