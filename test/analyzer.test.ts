import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {project} from './helpers.js';
import {readEvidence} from '../src/analyzer/evidence.js';
test('embedded_credentials_are_filtered_and_line_mapping_kept',()=>project(async root=>{
 await writeFile(join(root,'config.json'),'{\n "token": "secret-fixture",\n "url": "https://alice:secret-pass@example.test/api"\n}\n');
 const result=await readEvidence(root,'config.json',1,4);
 assert.doesNotMatch(result.content,/secret-fixture|secret-pass|alice/);
 assert.equal(result.evidence.startLine,1);assert.equal(result.evidence.endLine,4);
 assert.equal(result.evidence.digest,createHash('sha256').update(result.content).digest('hex'));
 assert.equal(result.content.split('\n').length,4);
}));
test('unknown_sensitive_format_is_denied',()=>project(async root=>{
 await writeFile(join(root,'auth.custom'),'token = secret-value');
 await assert.rejects(readEvidence(root,'auth.custom',1,1),/sensitive|unsupported/);
}));
test('jsonc_credentials_are_filtered',()=>project(async root=>{
 await writeFile(join(root,'config.jsonc'),'{// comment\n "env": {"TOKEN":"inline-secret"}, "name":"tool"\n}');
 const result=await readEvidence(root,'config.jsonc',1,3);
 assert.doesNotMatch(result.content,/inline-secret/);assert.match(result.content,/tool/);
}));
test('toml_sensitive_env_and_multiline_values_are_filtered',()=>project(async root=>{
 await writeFile(join(root,'config.toml'),'name = "tool"\n[env]\nTOKEN = "inline-secret"\nPASSWORD = """multi\nline-secret"""\n');
 const result=await readEvidence(root,'config.toml',1,5);
 assert.doesNotMatch(result.content,/inline-secret|line-secret|multi/);assert.match(result.content,/tool/);
 assert.equal(result.content.split('\n').length,5);
}));
test('numeric_credentials_and_yaml_aliases_cannot_bypass_filter',()=>project(async root=>{
 await writeFile(join(root,'config.json'),' {"password":123456789} ');
 assert.doesNotMatch((await readEvidence(root,'config.json',1,1)).content,/123456789/);
 await writeFile(join(root,'config.yaml'),'shared: &value hidden-secret\ntoken: *value\n');
 await assert.rejects(readEvidence(root,'config.yaml',1,2),/alias|unsupported/);
}));
