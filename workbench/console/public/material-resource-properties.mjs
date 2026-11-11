import {channelSpecs,paintChannels,effectiveValues} from './paint-channels.mjs';

const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;};

function outputPbr(graph){
  const output=graph.nodes.find(node=>node.type==='output');if(!output)return null;
  const visited=new Set(),stack=[output.id],found=[];
  while(stack.length){const id=stack.pop();if(visited.has(id))continue;visited.add(id);
    const node=graph.nodes.find(item=>item.id===id);if(node?.type==='pbr')found.push(node);
    for(const link of graph.links)if(link.to.node===id)stack.push(link.from.node);
  }
  return found.length===1?found[0]:null;
}

// Only unconnected inputs are directly editable; connected inputs remain node-driven.
export function createMaterialResourceProperties({host,project,getTarget,error}){
  const root=el('div','material-resource-properties');host.append(root);let signature='',targetKey='';
  function sync(status){
    const doc=project.document,target=getTarget(),item=status?.resource;
    if(!doc||!item||target?.kind!=='resource'){if(signature)root.replaceChildren();signature='';targetKey='';return;}
    const nextTarget=JSON.stringify([doc.id,target.projectId,target.resourceId]);
    const next=JSON.stringify([doc.id,doc.revision,target.resourceId]);if(next===signature)return;
    if(targetKey===nextTarget&&root.contains(document.activeElement)&&document.activeElement.hasAttribute('data-resource-dirty'))return;
    signature=next;targetKey=nextTarget;root.replaceChildren();
    const origin={id:doc.id,revision:doc.revision},id=target.resourceId;
    function commit(patch){
      const current=getTarget();
      if(project.document?.id!==origin.id||project.document.revision!==origin.revision||current?.kind!=='resource'||current.resourceId!==id||!project.document.paint.materials?.[id])throw Error('材质目标或工程修订已变化，请重新编辑');
      return project.commands([{op:'library',library:'materials',id,action:'update',patch}],origin);
    }
    function action(fn){Promise.resolve().then(fn).catch(error).finally(()=>{signature='';sync({resource:project.document?.paint.materials?.[getTarget()?.resourceId]});});}
    function row(parent,label,control){const item=el('label','render-settings-row');item.dataset.search=label;item.append(el('span','',label),control);parent.append(item);return control;}
    const info=el('details','render-settings-section');info.open=true;info.append(el('summary','','材质资源'));const infoBody=el('div','render-settings-body');info.append(infoBody);root.append(info);
    const name=el('input');name.type='text';name.maxLength=100;name.value=item.name;name.setAttribute('aria-label','材质资源名称');
    name.oninput=()=>{name.dataset.resourceDirty='';};
    name.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();name.blur();}else if(event.key==='Escape'){event.preventDefault();name.value=item.name;delete name.dataset.resourceDirty;name.blur();}};
    name.onchange=()=>{const value=name.value.trim();delete name.dataset.resourceDirty;if(value!==item.name)action(()=>commit({name:value}));};
    name.onblur=()=>{delete name.dataset.resourceDirty;};row(infoBody,'名称',name);
    const pbr=outputPbr(item.graph);
    if(!pbr){root.append(el('p','property-editor-unavailable','材质由节点图控制，请在节点编辑器中修改。'));return;}
    const section=el('details','render-settings-section');section.open=true;section.append(el('summary','','基础 PBR'));const body=el('div','render-settings-body');section.append(body);root.append(section);
    const values=effectiveValues(pbr.params);
    for(const key of paintChannels){
      const spec=channelSpecs[key],linked=item.graph.links.some(link=>link.to.node===pbr.id&&link.to.port===key);
      if(linked){const label=el('span','material-resource-linked','由节点控制');row(body,spec.name,label);continue;}
      const input=el('input');input.type=spec.type==='color'?'color':'number';input.value=String(values[key]);input.setAttribute('aria-label',spec.name);
      if(input.type==='number'){input.min='0';input.max='1';input.step='any';input.dataset.scrubNumber='';input.dataset.scrubSpeed='.01';}
      input.oninput=()=>{input.dataset.resourceDirty='';};
      if(input.type==='number')input.addEventListener('workspace-range-cancel',()=>{
        delete input.dataset.resourceDirty;
        sync({resource:project.document?.paint.materials?.[getTarget()?.resourceId]});
      });
      input.onchange=()=>{delete input.dataset.resourceDirty;const value=input.type==='number'?input.valueAsNumber:input.value;
        if(input.type==='number'&&(!Number.isFinite(value)||value<0||value>1)){error(Error(spec.name+'须为 0 到 1'));signature='';sync(status);return;}
        const graph=structuredClone(item.graph),node=graph.nodes.find(entry=>entry.id===pbr.id);node.params[key]=value;action(()=>commit({graph}));
      };
      input.onblur=()=>{delete input.dataset.resourceDirty;};row(body,spec.name,input);
    }
  }
  return {sync};
}
