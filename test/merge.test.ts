import {test} from 'node:test';import assert from 'node:assert/strict';
import {mergeManaged} from '../src/installer/merge.js';
const rows:[string,string|undefined,string|undefined,string|undefined,'update'|'remove',string][]=[
 ['new',undefined,undefined,'N','update','create'],['same','B','N','N','update','noop'],['unedited','B','B','N','update','update'],['user edited','B','L','B','update','keep'],['user deleted','B',undefined,'N','update','conflict'],['unowned',undefined,'L','N','update','conflict'],['unowned identical',undefined,'N','N','update','conflict'],['remove owned','B','B',undefined,'remove','remove'],['remove edited','B','L',undefined,'remove','conflict'],['remove gone','B',undefined,undefined,'remove','noop']
];
for(const [name,b,l,n,action,expected] of rows)test('B/L/N '+name,()=>assert.equal(mergeManaged(b,l,n,{action}).action,expected));
test('nonoverlapping_edits_merge',()=>{const r=mergeManaged('a\nb\nc\nd\n','A\nb\nc\nd\n','a\nb\nc\nD\n',{action:'update'});assert.equal(r.action,'update');assert.equal(r.content,'A\nb\nc\nD\n');});
test('overlapping_edits_conflict',()=>assert.equal(mergeManaged('a\n','L\n','N\n',{action:'update'}).action,'conflict'));
