export const imageShapeKinds=[['rectangle','矩形'],['ellipse','椭圆']];
const shapeKinds=new Set(imageShapeKinds.map(([id])=>id));
const color=value=>value===null||typeof value==='string'&&/^#[a-f\d]{6}$/i.test(value);
const integer=(value,min,max)=>Number.isInteger(value)&&value>=min&&value<=max;

export function validImageShape(shape){
  const keys=['kind','width','height','fill','stroke','strokeWidth','cornerRadius'];
  return shape&&typeof shape==='object'&&!Array.isArray(shape)&&Object.keys(shape).length===keys.length&&
    keys.every(key=>Object.hasOwn(shape,key))&&shapeKinds.has(shape.kind)&&
    integer(shape.width,1,4096)&&integer(shape.height,1,4096)&&color(shape.fill)&&color(shape.stroke)&&
    integer(shape.strokeWidth,0,512)&&integer(shape.cornerRadius,0,2048);
}

export function imageShapeSize(layer){
  const {width,height}=layer.shape,ratio=layer.scale*4096/Math.max(width,height);
  return [width,height].map((value,index)=>value*ratio*Math.abs(layer.stretch[index]));
}
