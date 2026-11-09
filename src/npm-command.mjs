import {statSync} from 'node:fs';
import {dirname,join} from 'node:path';

/** @param {string[]} args */
export function npmCommand(args) {
 if(process.platform!=='win32')return {executable:'npm',args};
 // npm.cmd is a batch file. Use the npm CLI from this Node installation
 // so project arguments are passed as argv, without a command interpreter.
 const cli=join(dirname(process.execPath),'node_modules','npm','bin','npm-cli.js');
 if(!statSync(cli,{throwIfNoEntry:false})?.isFile())throw Error('Native npm CLI unavailable beside Node.js');
 return {executable:process.execPath,args:[cli,...args]};
}
