import {isCancel,multiselect,select,spinner} from '@clack/prompts';
import type {Readable,Writable} from 'node:stream';
import {choiceOption,type Ask} from './prompt.js';
import {t} from './i18n/index.js';

export interface TerminalStreams {
 input:Readable & {isTTY?:boolean;isRaw?:boolean;setRawMode?(raw:boolean):void};
 output:Writable & {isTTY?:boolean};
}

export function terminalUI({input,output}:TerminalStreams,signal?:AbortSignal){
 if(!input.isTTY||!input.setRawMode||!output.isTTY||
  process.env.TERM==='dumb'||process.env.CI&&process.env.CI!=='false')return;
 if(process.platform==='win32'&&!process.env.WT_SESSION&&!process.env.ANSICON&&process.env.ConEmuANSI!=='ON'&&
  !/^(?:xterm|screen|tmux|vt100)/.test(process.env.TERM??''))return;
 const indicator=spinner({output,signal});
 const seen=new Set<string>();
 let running:string|undefined;
 const stop=()=>{
  if(running===undefined)return;
  indicator.stop(running);running=undefined;
 };
 const stage=(label:string,finished:boolean)=>{
  if(running!==label||finished)stop();
  if(!finished&&!seen.has(label)&&!signal?.aborted){
   seen.add(label);running=label;indicator.start(label);
  }
 };
 const ask:Ask=async({message,choices,defaults=[],multiple=false,empty=false,back=false})=>{
  stop();
  if(signal?.aborted||input.readableEnded||input.destroyed)return null;
  const controller=new AbortController();
  const cancel=()=>controller.abort();
  const eof=(_input:string,key?:{ctrl?:boolean;name?:string})=>{if(key?.ctrl&&key.name==='d')cancel();};
  const wasRaw=!!input.isRaw;
  input.once('end',cancel);input.once('close',cancel);
  signal?.addEventListener('abort',cancel,{once:true});
  const previous=Symbol('previous');
  const options=[...choices.map(choiceOption),...(back?[{value:previous,label:t('wizard.back')}]:[])];
  const common={message,options,input,output,signal:controller.signal};
  try{
   const pending=multiple
    ?multiselect<string|symbol>({...common,initialValues:defaults,cursorAt:defaults[0],required:!empty})
    :select<string|symbol>({...common,initialValue:defaults[0]});
   input.on('keypress',eof);
   const result=await pending;
   if(isCancel(result))return null;
   const selected=Array.isArray(result)?result:[result];
   if(selected.includes(previous))return 'back';
   return selected.filter((value):value is string=>typeof value==='string');
  }finally{
   input.off('end',cancel);input.off('close',cancel);
   input.off('keypress',eof);
   signal?.removeEventListener('abort',cancel);
   if(!input.destroyed&&!!input.isRaw!==wasRaw)input.setRawMode?.(wasRaw);
  }
 };
 return {ask,stage,stop};
}
