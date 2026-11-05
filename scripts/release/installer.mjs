import {readFile} from 'node:fs/promises';

export async function renderInstaller({version}) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw Error('Invalid installer release version');
  }
  const template = await readFile(new URL('./install.sh.in', import.meta.url), 'utf8');
  return template.replace('@@VERSION@@', 'v' + version);
}
