import {gzipSync,gunzipSync} from 'node:zlib';
import {checkStrokeBlock,isStrokeBlock,maxStrokeBlockBytes,strokeBlockSize} from './public/stroke-blocks.mjs';

const bindings=strokes=>[...new Set(strokes.map(stroke=>stroke.surfaceBinding).filter(Boolean))];
export function encodeStrokeBlock(strokes){
  try{
    if(!strokes.length||strokes.length>strokeBlockSize)throw Error('笔触块数量无效');
    const json=Buffer.from(JSON.stringify(strokes));
    if(json.length>maxStrokeBlockBytes)throw Error('笔触块过大');
    const refs=bindings(strokes);
    return {strokeBlock:gzipSync(json,{level:1}).toString('base64'),count:strokes.length,...(refs.length?{bindings:refs}:{})};
  }catch(error){
    throw Object.assign(Error('笔触压实失败，已保存的绘制未更改。请保留待保存笔触，重试保存。',{cause:error}),{status:503});
  }
}

function compactList(list){
  if(!Array.isArray(list))return list;
  const result=[];
  let pending=[];
  function flush(all){
    let block=[],stamps=0;
    for(const stroke of pending){
      block.push(stroke);
      stamps+=(stroke.stamps?.length??1)*(stroke.mirrorX?2:1);
      if(block.length===strokeBlockSize||stamps>=1024){
        result.push(encodeStrokeBlock(block));
        block=[];stamps=0;
      }
    }
    if(block.length){if(all)result.push(encodeStrokeBlock(block));else result.push(...block);}
    pending=[];
  }
  for(const stroke of list){
    if(isStrokeBlock(stroke)){if(pending.length)flush(true);result.push(stroke);}
    else pending.push(stroke);
  }
  if(pending.length)flush(false);
  return result;
}

export function compactPaintStrokes(paint){
  const layerSets=[paint.layers,...Object.values(paint.imageDocuments??{}).map(image=>image.layers)];
  for(const layers of layerSets)for(const layer of layers)for(const key of ['strokes','maskStrokes'])
    if(layer[key])layer[key]=compactList(layer[key]);
}

export function unpackStrokeBlock(block,options){
  checkStrokeBlock(block,options);
  try{
    const bytes=Buffer.from(block.strokeBlock,'base64');
    if(bytes.toString('base64')!==block.strokeBlock)throw Error('编码无效');
    const strokes=JSON.parse(gunzipSync(bytes,{maxOutputLength:maxStrokeBlockBytes}).toString('utf8'));
    if(!Array.isArray(strokes)||strokes.length!==block.count||strokes.some(stroke=>!stroke||typeof stroke!=='object'||Array.isArray(stroke)||isStrokeBlock(stroke))||
       JSON.stringify(bindings(strokes))!==JSON.stringify(block.bindings??[]))throw Error('记录不一致');
    return strokes;
  }catch(error){throw Error('无法读取压实笔触，原始工程未修改',{cause:error});}
}
