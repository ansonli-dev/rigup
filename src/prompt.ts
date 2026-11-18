import {createInterface} from 'node:readline';
import {StringDecoder} from 'node:string_decoder';
import {t} from './i18n/index.js';
export interface PromptIO {write(text:string):void;read(secret?:boolean):Promise<string|null>}
export type Choice=string|{value:string;label:string};
export interface Question {message:string;choices:Choice[];defaults?:string[];multiple?:boolean;empty?:boolean;back?:boolean}
export type Ask = (question:Question)=>Promise<string[]|'back'|null>;
export const choice=(value:string,label:string):Choice=>label===value?value:{value,label};
export const choiceOption=(choice:Choice)=>typeof choice==='string'?{value:choice,label:choice}:choice;

export async function askLine(io:PromptIO,{message,choices,defaults=[],multiple=false,empty=false,back=false}:Question):ReturnType<Ask>{
 const options=empty?[...choices,{value:'none',label:t('wizard.none')}]:choices;
 const selected=empty&&!defaults.length?['none']:defaults;
 const choiceLabels=new Map(options.map(choiceOption).map(({value,label})=>[value,label]));
 io.write(message+(multiple?t('prompt.numbers'):'')+
  (selected.length?t('prompt.default',{value:selected.map(value=>choiceLabels.get(value)??value).join(', ')}):'')+(back?t('prompt.back'):'')+'\n');
 for(;;){
  const answer=await promptChoice(io,options,false,selected,multiple);
  if(answer===null||answer==='back'&&back)return answer;
  if(!Array.isArray(answer))continue;
  if(!empty||!answer.includes('none'))return answer;
  if(answer.length===1)return [];
  io.write(t('prompt.noneOnly')+'\n');
 }
}

export function promptCancelled(value:string|null):value is null|'\x1b'|'\x03' {
 return value===null||value==='\x1b'||value==='\x03';
}

export async function promptChoice(io:PromptIO,choices:Choice[],secret=false,defaults:string[]=[],multiple=true):Promise<string[]|string|null>{
 const options=choices.map(choiceOption);
 if (!secret) io.write(options.map(({label},i)=>`${i+1}. ${label}`).join('\n')+'\n');
 for(;;){
  const raw=await io.read(secret);
  if(promptCancelled(raw))return null;
  if(secret)return raw;
  const answer=raw.trim();
  if(answer==='b'||answer==='back')return 'back';
  if(!answer&&defaults.length)return [...defaults];
  const indices=answer.split(/\s*[,，、]\s*|\s+/u);
  if((multiple||indices.length===1)&&indices.every(s=>/^\d+$/.test(s)&&Number(s)>=1&&Number(s)<=choices.length))
   return [...new Set(indices.map(s=>options[Number(s)-1].value))];
  io.write(t(multiple?'prompt.invalidMultiple':'prompt.invalidSingle')+'\n');
 }
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
export function terminalReader(input:import('node:stream').Readable,echo:(text:string)=>void=()=>{},signal?:AbortSignal): (secret?:boolean)=>Promise<string|null> {
 let lines:AsyncIterator<string>|undefined;
 return async(secret=false)=>{
  if(signal?.aborted)return null;
  const tty=input as NodeJS.ReadStream;
  if(secret||tty.isTTY) {
   if(!tty.isTTY || !tty.setRawMode) throw new Error('secret: hidden input requires TTY');
   if(tty.readableEnded||tty.destroyed)return null;
   return new Promise((resolve,reject)=>{
    let value=''; const wasRaw=tty.isRaw,decoder=new StringDecoder('utf8');
    const finish=(result:string|null)=>{
     tty.off('data',data);tty.off('end',end);tty.off('close',end);tty.pause();
     signal?.removeEventListener('abort',end);
     try{if(!tty.destroyed)tty.setRawMode(wasRaw);}catch(error){reject(error);return;}
     resolve(result);
    };
    const end=()=>finish(null);
    const data=(chunk:Buffer|string)=>{
     for(const char of typeof chunk==='string'?chunk:decoder.write(chunk)) {
      if(char === '\r' || char === '\n') {if(!secret)echo('\n');finish(value);return;}
      if(char === '\x03' || char === '\x04' || char === '\x1b') {finish(null);return;}
      if(char === '\x7f'){value=Array.from(value).slice(0,-1).join('');if(!secret)echo('\b \b');}else {value+=char;if(!secret)echo(char);}
     }
    };
    tty.setRawMode(true);tty.on('data',data);tty.once('end',end);tty.once('close',end);
    signal?.addEventListener('abort',end,{once:true});tty.resume();
   });
  }
  lines ??= createInterface({input,terminal:false})[Symbol.asyncIterator]();
  const result=await lines.next();return result.done ? null : result.value;
 };
}
