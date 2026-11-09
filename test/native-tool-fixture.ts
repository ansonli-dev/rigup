import {mkdir,symlink,writeFile} from 'node:fs/promises';
import {dirname,join,relative} from 'node:path';
import {toolPackage,type NativeTool} from '../src/integrations/tools/recipes.js';

export async function writeNativeToolFixture(root:string,id:NativeTool,version:string,type:'commonjs'|'module'='commonjs',target=toolPackage(id).prefix){
 const {name,entry}=toolPackage(id);
 const prefix=join(root,target),packageRoot=join(prefix,'node_modules',name),binary=join(packageRoot,entry);
 await mkdir(dirname(binary),{recursive:true});
 await writeFile(join(packageRoot,'package.json'),JSON.stringify({name,version,type,bin:{[id]:'./'+entry}}));
 await writeFile(binary,'#!/usr/bin/env node\n',{mode:0o755});
 let launcher=binary;
 if(process.platform!=='win32'){
  launcher=join(prefix,'node_modules','.bin',id);
  await mkdir(dirname(launcher),{recursive:true});
  await symlink(relative(dirname(launcher),binary),launcher);
 }
 return {prefix,packageRoot,binary,launcher};
}
