// Node-only fixture loader: stylesheet bytes have no executable persistence behavior.
// All JavaScript, including the production TeX workspace, loads unchanged.
export async function load(url,context,nextLoad){
 if(url.endsWith('.css'))return {format:'module',source:'',shortCircuit:true};
 return nextLoad(url,context);
}
