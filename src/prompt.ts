import {createInterface} from 'node:readline';
export interface PromptIO {write(text:string):void;read(secret?:boolean):Promise<string|null>}
export async function promptChoice(io:PromptIO,choices:string[],secret=false,defaults:string[]=[]):Promise<string[]|string|null>{
 if (!secret) io.write(choices.map((choice,i)=>`${i+1}. ${choice}`).join('\n')+'\n');
 const answer=await io.read(secret);
 if(answer === null || answer === '\x1b') return null;
 if(secret) return answer;
 if(answer==='b'||answer==='back')return 'back';
 if(answer.trim()===''&&defaults.length)return [...defaults];
 const indices=answer.split(',').map(s=>s.trim());
 if(indices.some(s=>!/^\d+$/.test(s) || Number(s)<1 || Number(s)>choices.length)) throw new Error('selection: invalid number');
 return [...new Set(indices.map(s=>choices[Number(s)-1]))];
}
export class ChoiceState {
 private values=new Map<string,unknown>();
 set(key:string,value:unknown):void {this.values.set(key,value);}
 get(key:string):unknown{return this.values.get(key);}
 back(key:string):void {
  const keys=[...this.values.keys()]; const index=keys.indexOf(key);
  if(index<0) return;
  for(const dependent of keys.slice(index+1)) this.values.delete(dependent);
 }
}
export function terminalReader(input:import('node:stream').Readable): (secret?:boolean)=>Promise<string|null> {
 let lines:AsyncIterator<string>|undefined;
 return async(secret=false)=>{
  const tty=input as NodeJS.ReadStream;
  if(secret||tty.isTTY) {
   if(!tty.isTTY || !tty.setRawMode) throw new Error('secret: hidden input requires TTY');
   return new Promise(resolve=>{
    let value=''; const wasRaw=tty.isRaw;
    const finish=(result:string|null)=>{tty.off('data',data);tty.off('end',end);tty.setRawMode(wasRaw);tty.pause();resolve(result);};
    const end=()=>finish(null);
    const data=(chunk:Buffer)=>{
     for(const char of chunk.toString('utf8')) {
      if(char === '\r' || char === '\n') {if(!secret)process.stdout.write('\n');finish(value);return;}
      if(char === '\x03' || char === '\x04' || char === '\x1b') {finish(null);return;}
      if(char === '\x7f'){value=value.slice(0,-1);if(!secret)process.stdout.write('\b \b');}else {value+=char;if(!secret)process.stdout.write(char);}
     }
    };
    tty.setRawMode(true);tty.on('data',data);tty.once('end',end);tty.resume();
   });
  }
  lines ??= createInterface({input,terminal:false})[Symbol.asyncIterator]();
  const result=await lines.next();return result.done ? null : result.value;
 };
}
