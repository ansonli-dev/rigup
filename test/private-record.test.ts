import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {access,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';
import {promisify} from 'node:util';
import {privateDirectory} from '../src/generator/cache.js';
import {readPrivateJson} from '../src/private-record.js';
import {project} from './helpers.js';

test('Windows private state rejects an NTFS grant to Everyone', {
 skip: process.platform !== 'win32' && 'requires NTFS access control',
}, () => project(root => project(async cache => {
 const icacls = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');
 const state = await privateDirectory(join(cache, 'new state 测试', 'nested'), root);
 const record = join(state, 'record.json');
 await writeFile(record, '{"fixture":true}', {mode: 0o600});
 assert.deepEqual(await readPrivateJson(record), {fixture:true});

 await promisify(execFile)(icacls, [record, '/grant', '*S-1-1-0:(R)']);
 await assert.rejects(readPrivateJson(record), /not private/);

 await promisify(execFile)(icacls, [state, '/grant', '*S-1-1-0:(RX)']);
 await assert.rejects(privateDirectory(state, root), /private permissions/);

 const ancestor = join(cache, 'replaceable parent');
 await mkdir(ancestor);
 await promisify(execFile)(icacls, [ancestor, '/grant', '*S-1-1-0:(WA)']);
 const nested = join(ancestor, 'must not create');
 await assert.rejects(privateDirectory(nested, root), /private permissions/);
 await assert.rejects(access(nested), {code:'ENOENT'});
 await assert.rejects(privateDirectory(join(cache,'ambiguous '),root), /unsafe Windows path/);
})));
