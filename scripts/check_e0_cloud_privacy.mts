import assert from 'node:assert/strict';
import type { CaptureBatch } from '../packages/contracts/src/index.ts';
import {
  assertCloudAnalysisRequestPrivacy,
  buildCloudAnalysisRequest
} from '../apps/extension/src/services/cloudAnalysisRequest.ts';

const batch: CaptureBatch = {
  schema_version: '0.1',
  batch_id: 'batch_privacy_fixture',
  trigger: 'rectangle',
  page: {
    url: 'https://private.example.test/releases?access_token=page-secret',
    title: 'Python download https://private.example.test/internal?token=title-secret',
    relevant_text: ['entire page text that must never be uploaded']
  },
  selection: {
    type: 'rectangle',
    candidate_ids: ['candidate_1'],
    rect: { x: 1, y: 2, width: 3, height: 4 }
  },
  device: { os: 'windows', arch: 'x64', locale: 'zh-CN' },
  candidates: [
    {
      candidate_id: 'candidate_1',
      value: 'https://cdn.example.test/python.exe?token=download-secret&expires=123',
      candidate_type: 'file',
      capture_channel: 'dom_link',
      page_url: 'https://private.example.test/releases?session=page-session',
      display_name: 'Python Windows x64 installer',
      anchor_text: 'Download https://cdn.example.test/python.exe?access_token=anchor-secret',
      nearby_text: 'Authorization: Bearer super-secret; stable Windows installer',
      section_heading: 'Windows',
      metadata: {
        filename: 'python.exe',
        extension: 'exe',
        resource_family_hint: 'software',
        content_type: 'application/octet-stream',
        content_length: 123456,
        authorization: 'Bearer hidden',
        cookie: 'session=hidden',
        local_path: 'C:/Users/demo/private'
      }
    }
  ],
  metadata: {
    raw_html: '<html>secret</html>',
    authorization: 'Bearer batch-secret'
  }
};

const request = buildCloudAnalysisRequest(batch);
assertCloudAnalysisRequestPrivacy(request);

const serialized = JSON.stringify(request);
assert.equal(request.page.title.includes('https://'), false);
assert.equal(request.candidates[0]?.candidate_id, 'candidate_1');
assert.equal(request.candidates[0]?.technical_metadata?.content_length, 123456);
assert.equal('value' in request.candidates[0]!, false);
assert.equal('page_url' in request.candidates[0]!, false);
assert.equal(serialized.includes('download-secret'), false);
assert.equal(serialized.includes('page-secret'), false);
assert.equal(serialized.includes('anchor-secret'), false);
assert.equal(serialized.includes('super-secret'), false);
assert.equal(serialized.includes('C:/Users/demo/private'), false);
assert.equal(serialized.includes('entire page text'), false);

console.log('E0 CloudAnalysisRequest privacy boundary: ok');
