import assert from 'node:assert/strict';
import {normalizeNpmIntegrity} from '../../src/npm-integrity.mjs';

export function verifyNativeSoftwareEvidence({previewId, softwareApproved, softwareInstalled}) {
  assert.ok(typeof previewId === 'string' && /^[a-f0-9]{64}$/.test(previewId), 'Native software preview ID is invalid');
  const ids = ['openwiki', 'codegraph'];
  const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
  const identities = (entries) => {
    assert.ok(Array.isArray(entries) && entries.length === ids.length, 'Native software evidence must cover both tools');
    return ids.map((id) => {
      const matches = entries.filter((entry) => entry?.id === id);
      assert.equal(matches.length, 1, `Native software evidence requires one entry for ${id}`);
      const [{version, packageIntegrity}] = matches;
      const integrity = normalizeNpmIntegrity(packageIntegrity);
      assert.ok(typeof version === 'string' && version.length <= 256 && stableVersion.test(version) && integrity,
        `Native software identity is invalid for ${id}`);
      return {id, version, packageIntegrity: integrity};
    });
  };
  assert.deepEqual(identities(softwareApproved), identities(softwareInstalled), 'Native software approval and installation differ');
}
