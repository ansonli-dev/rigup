import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixtureDiagnostic,fixtureError} from './fixture-diagnostics.js';

test('fixture diagnostics bound output and redact paths and credentials in text and JSON',()=>{
 const path='C:\\private\\fixture';
 const output=fixtureDiagnostic({path,authorization:'Bearer fixture-bearer',token:'fixture-token',password:'fixture-password',message:'https://user:fixture-password@example.test/ token=fixture-token'},[path]);
 for(const secret of [path,'C:\\\\private','fixture-bearer','fixture-token','fixture-password'])assert.ok(!output.includes(secret),output);
 assert.match(output,/<fixture>/);assert.match(output,/<redacted>/);
 assert.ok(fixtureDiagnostic('x'.repeat(20_000)).length<=8000);
});

test('fixture command evidence retains exit, signal, timeout and both output streams within bounds',()=>{
 const error=Object.assign(Error('failed '+ 'x'.repeat(10_000)),{code:128,signal:'SIGTERM',killed:true,stdout:JSON.stringify({phase:'apply',summary:'outgoing Git error',padding:'x'.repeat(20_000),error:'final apply failure'}),stderr:'fatal backend configuration\n'+'x'.repeat(20_000)+'\nfinal stderr failure'});
 const output=fixtureError(error);
 assert.match(output,/"code":128/);assert.match(output,/"killed":true/);assert.match(output,/SIGTERM/);
 assert.match(output,/outgoing Git error/);assert.match(output,/fatal backend configuration/);assert.ok(output.length<=8000);
 assert.match(output,/final apply failure/);assert.match(output,/final stderr failure/);
});
