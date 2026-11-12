export function modelStepForSource(step, resolve) {
  const targets = new Map();
  const positions = step.type === 'vertexPositions';
  for (const target of step.targets) {
    const resolved = resolve(target);
    if (!resolved?.object) throw Error('建模命令与原模型绑定不一致');
    const {object, vertices} = resolved;
    if (!vertices) {
      if (targets.get(object)?.points) throw Error('建模命令同时修改同一物体和网格');
      targets.set(object, {object});
      continue;
    }
    if (!targets.has(object)) targets.set(object, {object, points: new Map()});
    const points = targets.get(object).points;
    if (!points) throw Error('建模命令同时修改同一物体和网格');
    vertices.forEach((id, index) => {
      if (!Number.isSafeInteger(id) || id < 0) throw Error('建模命令与原拓扑绑定不一致');
      const xyz = positions ? target.positions.slice(index * 3, index * 3 + 3) : null;
      const previous = points.get(id);
      if (previous && previous.some((value, axis) => value !== xyz[axis]))
        throw Error('原 UV 接缝顶点必须保持一致');
      points.set(id, xyz);
    });
  }
  const result = [...targets.values()].map(({object, points}) => {
    if (!points) return {object};
    const vertices = [...points.keys()];
    return positions ? {object, vertices, positions: [...points.values()].flat()} : {object, vertices};
  });
  return positions ? {type: step.type, targets: result} : {matrix: step.matrix, targets: result};
}

export function writeVertexPositions(attribute, {vertices, positions}) {
  vertices.forEach((id, index) => {
    const start = index * 3;
    attribute.setXYZ(id, positions[start], positions[start + 1], positions[start + 2]);
  });
  attribute.needsUpdate = true;
}
