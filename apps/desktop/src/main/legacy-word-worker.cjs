const {parentPort,workerData}=require('node:worker_threads');
const WordExtractor=require('word-extractor');
new WordExtractor().extract(Buffer.from(workerData)).then(doc=>{
 const text=doc.getBody();if(typeof text!=='string'||text.length>4*1024*1024)throw Error('DOC 正文过大。');
 parentPort.postMessage({text});
}).catch(error=>parentPort.postMessage({error:error.message}));
