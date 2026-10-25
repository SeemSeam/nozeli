export function dispositionIntent(work,decision='discard',requestKey=`end:${work.id}`){
  return {by:'user',revision:work.revision,decision,requestKey,binding:{workId:work.id,revision:work.revision,objectId:work.result?.objectId??null,candidateCommit:work.execution?.candidate?.commit??null}};
}
