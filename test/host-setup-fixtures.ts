import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';

export const ompId='@loneexile/omp-superpowers';
export const requiredSkills=['brainstorming','writing-plans','executing-plans','verification-before-completion'];
export const latestUrl='https://registry.npmjs.org/@loneexile%2fomp-superpowers/latest';

export function ompArchive(version='9.9.9-omp.1'){
 const files={
  'package.json':JSON.stringify({name:ompId,version,pi:{extensions:['./.pi/extensions/superpowers.ts']},
   scripts:{test:'exit 1'},dependencies:{example:'1.0.0'}}),
  '.pi/extensions/superpowers.ts':'export default function() {}',
  ...Object.fromEntries(requiredSkills.map(name=>['skills/'+name+'/SKILL.md','---\nname: '+name+'\ndescription: Fixture\n---\n'])),
 };
 const tar=Buffer.concat([...Object.entries(files).map(([name,text])=>{
  const bytes=Buffer.from(text),block=Buffer.alloc(512+Math.ceil(bytes.length/512)*512);
  block.write('package/'+name);
  block.write('0000644\0',100);
  block.write(bytes.length.toString(8).padStart(11,'0')+'\0',124);
  block.write('0',156);
  block.write('ustar\0',257);
  block.fill(0x20,148,156);
  block.write(block.subarray(0,512).reduce((sum,byte)=>sum+byte,0).toString(8).padStart(6,'0')+'\0 ',148);
  bytes.copy(block,512);
  return block;
 }),Buffer.alloc(1024)]);
 const bytes=gzipSync(tar);
 const integrity='sha512-'+createHash('sha512').update(bytes).digest('base64');
 const tarball='https://registry.npmjs.org/@loneexile/omp-superpowers/-/omp-superpowers-'+version+'.tgz';
 const pin={version,integrity,tarball};
 return {bytes,pin,files,metadata:()=>Response.json({name:ompId,version,dist:{integrity,tarball}})};
}
