import {createHash} from 'node:crypto';

const keyEncodings=new Map();
export function canonical(value){
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value!==null&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>{let encoded=keyEncodings.get(key);if(encoded===undefined){encoded=JSON.stringify(key);if(keyEncodings.size<8192)keyEncodings.set(key,encoded);}return encoded+':'+canonical(value[key]);}).join(',')+'}';
 return JSON.stringify(value);
}

// Execution constraints are checked separately. Changing the generation or
// open mode does not change the identity of the original logical request.
export function fingerprint(op,args){
 const {operationId,generation,mustExist,...request}=args;
 return createHash('sha256').update(canonical(JSON.parse(JSON.stringify({op,args:request})))).digest('hex');
}
