import assert from 'node:assert/strict';
import {DesktopHost} from '../../src/main/host.mjs';

// Every host, including same-process reopen readers, owns native directory
// pins and SQLite workers. Join their confirmed shutdown before fixture removal.
export function desktopHosts() {
  const hosts=[];
  let closing;
  return {
    create(...args) {
      assert.equal(closing,undefined,'fixture host admission is closed');
      const host=new DesktopHost(...args);
      hosts.push(host);
      return host;
    },
    close() {
      return closing??=(async()=>{
        const outcomes=await Promise.allSettled(hosts.map(async host=>{
          await host.settled();
          const results=await host.storage.db.close();
          assert.equal(results.some(result=>result?.closed===false),false,'storage shutdown remains unconfirmed; retain fixture');
          assert.equal(host.storage.db.channels.size,0,'storage worker is still live; retain fixture');
        }));
        const errors=outcomes.filter(result=>result.status==='rejected').map(result=>result.reason);
        if(errors.length)throw new AggregateError(errors,'Fixture hosts did not all close; retain synthetic data');
      })();
    },
  };
}
