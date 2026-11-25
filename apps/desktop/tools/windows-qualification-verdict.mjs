// The first-release source gate is deliberately small. No skips are allowed.
export const windowsReleaseCases=Object.freeze([
 'generated launcher propagates a nonzero application exit and preserves its JSON receipt',
 'candidate rejects a manifest version that differs from the packaged application',
 'Windows source checkout checks its ZIP channel but cannot download or activate an unowned installation',
]);

export function windowsQualificationPassed({suite,exitCode,identityVerified,counts,tap}){
 if(exitCode!==0||!identityVerified)return false;
 if(suite==='identity')return true;
 if(!(counts.pass>0&&counts.fail===0&&counts.cancelled===0))return false;
 if(suite!=='release')return true;
 if(counts.skipped!==0||counts.tests!==counts.pass)return false;
 const passedNames=[...tap.matchAll(/^ok \d+ - ([^\r\n]+)\r?$/gm)].map(match=>match[1]);
 return windowsReleaseCases.every(name=>passedNames.filter(passed=>passed===name).length===1);
}
