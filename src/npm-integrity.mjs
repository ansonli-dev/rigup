const digestBytes={sha512:64,sha384:48,sha256:32};

/** @param {unknown} value */
export function normalizeNpmIntegrity(value){
 if(typeof value!=='string'||!value.trim())return;
 const digests=new Set();
 for(const token of value.trim().split(/\s+/)){
  const match=/^(sha512|sha384|sha256)-([A-Za-z0-9+/]+={0,2})(?:\?[\x21-\x7e]*)?$/.exec(token);
  if(!match)return;
  const [,algorithm,base64]=match;
  const bytes=Buffer.from(base64,'base64');
  if(bytes.length!==digestBytes[algorithm]||bytes.toString('base64')!==base64)return;
  digests.add(algorithm+'-'+base64);
 }
 return [...digests].sort((left,right)=>digestBytes[right.split('-')[0]]-digestBytes[left.split('-')[0]]||(left<right?-1:1)).join(' ');
}
