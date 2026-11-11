export function createEditorRegistry({decorate=()=>{}}={}){
  const types=new Map(),instances=new Set();
  return {
    register(type,factory){if(types.has(type)||typeof factory!=='function')throw Error('编辑器重复注册');types.set(type,factory);},
    create(type,context){
      const factory=types.get(type);if(!factory)throw Error('未知编辑器 '+type);
      const editor=factory(context)||{},abort=new AbortController();decorate(context);
      const instance={...editor,type,signal:abort.signal,dispose(){if(!instances.has(instance))return;abort.abort();editor.dispose?.();instances.delete(instance);}};
      instances.add(instance);return instance;
    },
    dispose(){for(const instance of [...instances])instance.dispose();},
    get size(){return instances.size;},get types(){return [...types.keys()];}
  };
}
