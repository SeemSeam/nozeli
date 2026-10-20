import test from 'node:test';
import assert from 'node:assert/strict';
import {renderConfigurationNotice} from '../src/renderer/configuration-notice.mjs';

test('missing private login displays only nonsecret status and clears after login or project switch',()=>{
  const node={hidden:true,textContent:''};
  const agent={target:'frontdesk',configurationStatus:{loginRequired:true,unresolvedProviders:['example-service']}};
  renderConfigurationNotice(node,[agent]);
  assert.equal(node.hidden,false);
  assert.match(node.textContent,/Nozeli 私有 OMP 中登录或配置服务/);
  assert.match(node.textContent,/官方 OMP 不受影响/);
  assert.deepEqual(agent,{target:'frontdesk',configurationStatus:{loginRequired:true,unresolvedProviders:['example-service']}},'notice never mutates runtime readiness or native attach state');
  renderConfigurationNotice(node,[{configurationStatus:{loginRequired:false}}]);
  assert.equal(node.hidden,true);assert.equal(node.textContent,'');
  renderConfigurationNotice(node,[agent]);renderConfigurationNotice(node,[]);
  assert.equal(node.hidden,true);assert.equal(node.textContent,'');
});
