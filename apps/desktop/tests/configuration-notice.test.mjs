import test from 'node:test';
import assert from 'node:assert/strict';
import {renderConfigurationNotice} from '../src/renderer/configuration-notice.mjs';

test('missing private login displays only nonsecret status and clears after login or project switch',()=>{
  const node={hidden:true,textContent:''};
  const agent={target:'frontdesk',configurationStatus:{loginRequired:true,unresolvedProviders:['example-service']}};
  renderConfigurationNotice(node,[agent]);
  assert.equal(node.hidden,false);
  assert.match(node.textContent,/AI 连接与账号/);
  assert.doesNotMatch(node.textContent,/密钥|token|secret/i);
  assert.deepEqual(agent,{target:'frontdesk',configurationStatus:{loginRequired:true,unresolvedProviders:['example-service']}},'notice never mutates runtime readiness or native attach state');
  renderConfigurationNotice(node,[{configurationStatus:{loginRequired:false}}]);
  assert.equal(node.hidden,true);assert.equal(node.textContent,'');
  renderConfigurationNotice(node,[agent]);renderConfigurationNotice(node,[]);
  assert.equal(node.hidden,true);assert.equal(node.textContent,'');
  renderConfigurationNotice(node,[{target:'worker',configurationStatus:'unconfigured'}]);
  assert.equal(node.hidden,false);assert.match(node.textContent,/AI 连接与账号/);
  renderConfigurationNotice(node,[{configurationStatus:'configured'}]);
  assert.equal(node.hidden,true);assert.equal(node.textContent,'');
});
