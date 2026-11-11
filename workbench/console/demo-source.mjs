import {createHash} from 'node:crypto';

export const demoProjectId='cce9f54f-256c-4e2d-9f86-8f5f0ad251af';

export function bindingFingerprint(doc){
  return createHash('sha256').update(JSON.stringify({
    material:doc.source.material,
    files:Object.entries(doc.source.files).sort(([a],[b])=>a.localeCompare(b))
  })).digest('hex');
}
