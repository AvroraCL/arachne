from PIL import Image
import numpy as np, json, struct, sys
from pathlib import Path
out=Path(sys.argv[1])
p=bytearray()
g={'asset':{'version':'2.0'},'scene':0,'scenes':[{'nodes':[0]}],'nodes':[{'mesh':0}],
   'materials':[{'name':'target','pbrMetallicRoughness':{'baseColorFactor':[0,0,0,1],'metallicFactor':0,'roughnessFactor':1}}],
   'bufferViews':[],'accessors':[]}
def accessor(values,shape,size,bounds=None):
    i=len(g['accessors'])
    g['bufferViews'].append({'buffer':0,'byteOffset':len(p),'byteLength':4*len(values)})
    p.extend(struct.pack('<'+'f'*len(values),*values))
    item={'bufferView':i,'componentType':5126,'type':shape,'count':len(values)//size}
    if bounds: item.update(min=bounds[0],max=bounds[1])
    g['accessors'].append(item)
    return i
v=[-1,-1,0,1,-1,0,1,1,0,-1,-1,0,1,1,0,-1,1,0]
low,high=1024/4096,1152/4096
uv=[low,1,high,1,high,0,low,1,high,0,low,0]
g['meshes']=[{'primitives':[{'attributes':{'POSITION':accessor(v,'VEC3',3,([-1,-1,0],[1,1,0])),
'TEXCOORD_0':accessor(uv,'VEC2',2)},'material':0}]}]
g['buffers']=[{'byteLength':len(p)}]
j=json.dumps(g).encode();j+=b' '*(-len(j)%4)
(out/'model.glb').write_bytes(struct.pack('<4sII',b'glTF',2,28+len(j)+len(p))+struct.pack('<I4s',len(j),b'JSON')+j+struct.pack('<I4s',len(p),b'BIN\0')+p)
a=np.zeros((64,4096,3),np.uint8);a[:,::2]=255
Image.fromarray(a).save(out/'emission.png')
Image.new('RGB',(64,64),(128,128,128)).save(out/'roughness.png')
Image.fromarray(np.repeat(a,4096//64,axis=0)).save(out/'square-emission.png')
Image.new('RGB',(4096,4096),(128,128,128)).save(out/'square-roughness.png')
g['materials'][0]['emissiveFactor']=[.19,.36,.53]
j=json.dumps(g).encode();j+=b' '*(-len(j)%4)
(out/'flat.glb').write_bytes(struct.pack('<4sII',b'glTF',2,28+len(j)+len(p))
    +struct.pack('<I4s',len(j),b'JSON')+j+struct.pack('<I4s',len(p),b'BIN\0')+p)
