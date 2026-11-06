import test from 'node:test';
import assert from 'node:assert/strict';
import {createMessageAttentionPresentation} from '../src/domain/attention-presentation.mjs';

const reply=(overrides={})=>({id:'message-1',sessionId:'thread-1',speaker:'agent',target:'work-1',text:'真实回复',revision:2,objectId:'publication-2',...overrides});
test('message attention uses exact project/thread/message/publication identity, never summary or todo ack',()=>{
  const model=createMessageAttentionPresentation(),entry=reply();
  model.observe('a',[entry]);model.observe('b',[entry]);
  const version=model.version;model.observe('a',[{...entry}]);assert.equal(model.version,version);
  assert.equal(model.hasUnread('a'),true);assert.equal(model.forWork('a','work-1'),true);
  assert.equal(model.presented({projectId:'a',threadId:'other',messageId:entry.id}),true);
  assert.equal(model.hasUnread('a'),true);
  assert.equal(model.presented({projectId:'a',threadId:entry.sessionId,messageId:entry.id,objectId:'publication-1',revision:1}),false);
  assert.equal(model.hasUnread('a'),true);
  assert.equal(model.presented({projectId:'a',threadId:entry.sessionId,messageId:entry.id,objectId:entry.objectId,revision:entry.revision}),true);
  assert.equal(model.hasUnread('a'),false);assert.equal(model.hasUnread('b'),true);
  model.observe('a',[entry]);assert.equal(model.hasUnread('a'),false);
  model.observe('a',[reply({id:'message-2'})]);assert.equal(model.hasUnread('a'),true);
});
test('validated early presentation and canonical streaming replacement do not re-alert',()=>{
  const model=createMessageAttentionPresentation();
  model.presented({projectId:'a',threadId:'thread-1',messageId:'message-1',objectId:'publication-2',revision:2});
  model.observe('a',[reply()]);assert.equal(model.hasUnread('a'),false);
  model.observe('a',[reply({id:'durable-1',replacesId:'message-1'})]);assert.equal(model.hasUnread('a'),false);
});
test('missing canonical identity only yields a conservative message point, not a count or fabricated read',()=>{
  const model=createMessageAttentionPresentation();
  model.observe('a',[reply({id:null,sessionId:null})]);assert.equal(model.hasUnread('a'),true);
  assert.equal(model.presented({projectId:'a',messageId:'guessed'}),false);assert.equal(model.hasUnread('a'),true);
  const other=createMessageAttentionPresentation();other.observe('a',[reply({speaker:'user'}),reply({hostTurnStatus:true}),reply({text:''})]);assert.equal(other.hasUnread('a'),false);
});
