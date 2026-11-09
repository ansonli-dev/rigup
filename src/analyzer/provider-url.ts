export function validateProviderBaseURL(value:string):URL {
 const invalid=()=>new Error('provider base URL must use HTTPS or loopback HTTP and omit credentials, query, and fragment');
 const authority=/^https?:\/\/([^/]+)/i.exec(value)?.[1];
 if(!authority || authority.includes('@') || /[?#\s\\]/.test(value))throw invalid();
 let url:URL;
 try{url=new URL(value);}catch{throw invalid();}
 const loopback=url.hostname==='localhost' || url.hostname==='[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
 if(url.username || url.password || (url.protocol!=='https:' && !(url.protocol==='http:' && loopback)))throw invalid();
 return url;
}
