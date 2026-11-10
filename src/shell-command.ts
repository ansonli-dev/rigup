export function quoteShell(value:string):string {
 if(process.platform==='win32')return "'"+value.replaceAll("'","''")+"'";
 return quotePosixShell(value);
}

export function quotePosixShell(value:string):string {
 return "'"+value.replaceAll("'","'\"'\"'")+"'";
}

export function quoteShellList(values:readonly string[]):string {
 const list=values.join(',');
 return process.platform==='win32'&&values.length>1?quoteShell(list):list;
}
