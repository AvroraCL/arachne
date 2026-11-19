import {TextureLoader} from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';

export function createViewportModelLoader(){
  const loader=new GLTFLoader();
  // WebKit ImageBitmap drops RGB at alpha zero, even with premultiplyAlpha:none.
  // Embedded PNGs need their straight color when inspecting a cutout material.
  if(navigator.vendor==='Apple Computer, Inc.')loader.register(parser=>{
    const png=new TextureLoader(parser.options.manager);
    return {name:'ArachneEmbeddedPNG',loadTexture(index){
      const source=parser.json.textures[index].source,image=parser.json.images?.[source];
      if(image?.mimeType==='image/png'&&image.bufferView!==undefined)
        return parser.loadTextureImage(index,source,png);
      return null;
    }};
  });
  return loader;
}
