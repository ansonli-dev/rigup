// Fixture output only: bound each record and omit scratch paths and credentials.
export function fixtureDiagnostic(value:unknown,paths:string[]=[],limit=8000):string{
 let text=typeof value==='string'?value:JSON.stringify(value)??String(value);
 for(const path of [...paths].filter(Boolean).sort((a,b)=>b.length-a.length)){
  text=text.replaceAll(path,'<fixture>').replaceAll(path.replaceAll('\\','/'),'<fixture>').replaceAll(JSON.stringify(path).slice(1,-1),'<fixture>');
 }
 text=text.replace(/\x1b\[[0-9;]*m/g,'').replace(/("(?:authorization|token|password|secret|api[_-]?key)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,'$1"<redacted>"').replace(/\bBearer\s+[^\s"']+/gi,'Bearer <redacted>')
  .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi,'$1<redacted>@')
  .replace(/((?:token|password|secret|api[_-]?key)\s*[=:]\s*)[^\s,"']+/gi,'$1<redacted>')
  .replace(/[\x00-\x08\x0b-\x1f\x7f]/g,'?');
 if(text.length<=limit)return text;
 const marker='\n<truncated>\n',head=Math.floor((limit-marker.length)/2);
 return text.slice(0,head)+marker+text.slice(-(limit-marker.length-head));
}

export function fixtureError(error:unknown,paths:string[]=[]):string{
 if(!(error instanceof Error))return fixtureDiagnostic(error,paths);
 const child=error as Error&{code?:unknown;signal?:unknown;killed?:boolean;stdout?:unknown;stderr?:unknown};
 return fixtureDiagnostic({name:error.name,message:fixtureDiagnostic(error.message,paths,1200),code:child.code,signal:child.signal,killed:child.killed,stdout:fixtureDiagnostic(String(child.stdout??''),paths,1000),stderr:fixtureDiagnostic(String(child.stderr??''),paths,1200)},paths);
}
