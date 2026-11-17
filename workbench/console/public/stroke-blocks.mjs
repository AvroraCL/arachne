export const strokeBlockSize=64;
export const maxStrokeBlockBytes=8*1024*1024;

export const isStrokeBlock=value=>!!value&&Object.hasOwn(value,'strokeBlock');
export const strokeCount=strokes=>(strokes??[]).reduce((count,stroke)=>count+(isStrokeBlock(stroke)?stroke.count:1),0);
export function checkStrokeBlock(value,{mask=false,spatial=false}={}){
  if(!isStrokeBlock(value)||Object.keys(value).some(key=>!['strokeBlock','count','bindings','inverted'].includes(key))||
     typeof value.strokeBlock!=='string'||!value.strokeBlock.length||value.strokeBlock.length>Math.ceil(maxStrokeBlockBytes/3)*4||
     !Number.isInteger(value.count)||value.count<1||value.count>strokeBlockSize||
     value.inverted!==undefined&&(!mask||value.inverted!==true)||
     value.bindings!==undefined&&(!spatial||!Array.isArray(value.bindings)||!value.bindings.length||
       value.bindings.length>value.count||new Set(value.bindings).size!==value.bindings.length||
       value.bindings.some(key=>typeof key!=='string'||!(/^(?:original|[a-f\d]{64})$/).test(key))))
    throw Error('笔触压实块无效');
}
