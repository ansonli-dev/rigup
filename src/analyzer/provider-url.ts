export function validateProviderBaseURL(value:string):URL {
 const invalid=()=>Error('provider base URL must use HTTP or HTTPS without credentials, secret query parameters, or a fragment');
 let url:URL;
 try{url=new URL(value);}catch{throw invalid();}
 const authority=/^https?:\/\/([^/?#]+)/i.exec(value.trim())?.[1];
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||authority?.includes('@')||value.includes('#')||
    [...url.searchParams.keys()].some(name=>credentialQuery.has(name.toLowerCase().replace(/[._-]/g,''))))throw invalid();
 return url;
}

const credentialQuery=new Set(['key','apikey','token','accesstoken','refreshtoken','authtoken','authtokenid','privatekey',
 'secret','clientsecret','password','passwd','authorization','auth','cookie','setcookie','credential','credentials','signature','sig']);

export function validateTrackerURL(value:string):URL {
 const invalid=()=>Error('tracker URL must use HTTPS or loopback HTTP and omit credentials, query, and fragment');
 const authority=/^https?:\/\/([^/]+)/i.exec(value)?.[1];
 if(!authority || authority.includes('@') || /[?#\s\\]/.test(value))throw invalid();
 let url:URL;
 try{url=new URL(value);}catch{throw invalid();}
 const loopback=url.hostname==='localhost' || url.hostname==='[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
 if(url.username || url.password || (url.protocol!=='https:' && !(url.protocol==='http:' && loopback)))throw invalid();
 return url;
}
