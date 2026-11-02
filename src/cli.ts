#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {terminalReader} from './prompt.js';
import {loadOptions} from './config.js';

export interface CliIO {
  cwd: string;
  isTTY: boolean;
  write(text: string): void;
  read?(secret?:boolean): Promise<string|null>;
}

const help = 'rigup init [path]\nrigup update [path]\nrigup doctor [path]\n';
export async function runCli(argv: string[], io: CliIO): Promise<number> {
  if (argv.some(arg => arg.startsWith('-') && !['--help','--version'].includes(arg))) {
    io.write('Unknown option\n'); return 2;
  }
  if (argv.includes('--help')) { io.write(help); return 0; }
  if (argv.includes('--version')) { io.write('0.1.0\n'); return 0; }
  if (!argv.length && !io.isTTY) { io.write(help + 'Choose a lifecycle command\n'); return 2; }
  const root=resolve(io.cwd,argv[1] ?? '.');
  let installed=false;
  try {
    const manifest=JSON.parse(await readFile(resolve(root,'.rigup/manifest.json'),'utf8'));
    if (manifest?.schemaVersion !== 1 || typeof manifest.installId !== 'string' || !Array.isArray(manifest.assets)) throw new Error('invalid structure');
    installed=true;
  } catch(error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      io.write('manifest: damaged metadata; diagnose before setup\n'); return 1;
    }
  }
  if (!argv.length) {
    io.write(installed ? '1. update\n2. doctor\n3. exit\n' : '1. init\n2. doctor\n3. exit\n');
    const answer=await io.read?.();
    if (answer == null || answer === '3') return 130;
    if (!['1','2'].includes(answer)) return 2;
    argv=[answer === '2' ? 'doctor' : installed ? 'update' : 'init'];
  }
  if (installed && argv[0] === 'init') argv=['update',...argv.slice(1)];
  if (!['init','update','doctor'].includes(argv[0]) || argv.length > 2) {
    io.write(help); return 2;
  }
  try { await loadOptions(resolve(io.cwd,argv[1] ?? '.'),{}); }
  catch (error) { io.write((error as Error).message + '\n'); return 2; }
  io.write(argv[0] + ': 尚未实现\n');
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runCli(process.argv.slice(2), {
    cwd:process.cwd(), isTTY:!!process.stdin.isTTY,
    write:text => process.stdout.write(text),
    read:terminalReader(process.stdin),
  });
}
