import assert from 'node:assert/strict';

// Real Work-list context-menu route; a queued Work has no report to act on.
export async function discardWorkFromList(page,workId){
 await page.locator('[data-managed-work="'+workId+'"] .managed-work-open').click({button:'right'});
 await page.waitForSelector('#managed-work-menu:not([hidden])',{visible:true});
 await page.locator('#managed-work-menu [data-command="discard"]').click();
 await page.waitForSelector('.managed-report-dialog[open]',{visible:true});
 assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'取消','Dangerous confirmation must default to cancellation');
 await page.keyboard.press('Tab');await page.keyboard.press('Enter');
 await page.waitForSelector('.managed-report-dialog',{hidden:true});
}
