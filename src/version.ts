import {readFileSync} from 'node:fs';

export const RIGUP_VERSION:string=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
