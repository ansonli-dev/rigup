export function quoteShell(value:string):string {
 if(process.platform==='win32')return "'"+value.replaceAll("'","''")+"'";
 return quotePosixShell(value);
}

export function quotePosixShell(value:string):string {
 return "'"+value.replaceAll("'","'\"'\"'")+"'";
}
