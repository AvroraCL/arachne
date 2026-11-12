import {createHash} from 'node:crypto';

export const demoProjectId='cce9f54f-256c-4e2d-9f86-8f5f0ad251af';
export const nativeDemoProjectId='d79dcdd3-fd07-4482-842e-1aba21cf2332';

export function bindingFingerprint(doc){
  return createHash('sha256').update(JSON.stringify({
    material:doc.source.material,
    files:Object.entries(doc.source.files).sort(([a],[b])=>a.localeCompare(b))
  })).digest('hex');
}
