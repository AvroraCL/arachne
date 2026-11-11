const comparisons=new WeakMap();

// Server documents are immutable snapshots between revisions/polls. Avoid
// serializing a large modeling history on every viewport pointer event.
export function projectionIsCurrent(doc,layer){
  if(!layer?.surfaceBinding)return true;
  let cached=comparisons.get(doc);
  if(!cached){cached=new Map();comparisons.set(doc,cached);}
  const key=layer.surfaceBinding;
  if(!cached.has(key)){
    const current=doc.modeling?.steps?.length?doc.modeling:null;
    const original=doc.paint.surfaceBindings?.[key];
    cached.set(key,original!==undefined&&JSON.stringify(original)===JSON.stringify(current));
  }
  return cached.get(key);
}
