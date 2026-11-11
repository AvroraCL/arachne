import {evaluateBrushGraph} from './paint-library.mjs';

// Each editor keeps its own local adjustments while following the shared
// selected brush and any temporary node preview for that brush.
export function createBrushBinding({project,painter,onApplied=()=>{}}){
  let selection=null,applied='',snapshot=null,reselectPending=false,savedGraph='',savedValue=null,draftGraph='',draftValue=null;
  function apply(settings,temporary=false){painter.setSettings(settings,{persist:!temporary});onApplied(settings);}
  function settingsFor(graph,temporary=false){
    const key=JSON.stringify(graph);
    if(temporary){if(key!==draftGraph){draftGraph=key;draftValue=evaluateBrushGraph(graph);}return draftValue;}
    if(key!==savedGraph){savedGraph=key;savedValue=evaluateBrushGraph(graph);}return savedValue;
  }
  function sync(reselect=false){
    reselectPending ||= reselect;
    if(painter.isEditing())return;
    const doc=project.document,target=project.resource,brush=target?.library==='brushes'&&doc?.paint.brushes?.[target.id];
    const next=brush?JSON.stringify([doc.id,target.id]):null;
    if(selection!==next||reselectPending){
      if(snapshot)apply(snapshot.settings);
      selection=next;applied='';snapshot=null;reselectPending=false;
    }
    if(!brush)return;
    const savedSettings=settingsFor(brush.graph),saved=JSON.stringify(savedSettings),savedKey=JSON.stringify([selection,savedSettings]),draft=project.brushDraft;
    const preview=draft?.origin.id===doc.id&&draft.origin.revision===doc.revision&&draft.origin.target?.id===target.id?draft.graph:null;
    if(preview){
      if(!snapshot){
        if(!applied){apply(savedSettings);applied=savedKey;}
        snapshot={settings:painter.getSettings(),saved};
      }
      const previewSettings=settingsFor(preview,true),previewKey=JSON.stringify([selection,previewSettings]);
      if(applied!==previewKey){apply(previewSettings,true);applied=previewKey;}
    }else if(snapshot){
      apply(snapshot.saved===saved?snapshot.settings:savedSettings);
      snapshot=null;applied=savedKey;
    }else if(applied!==savedKey){apply(savedSettings);applied=savedKey;}
  }
  return {sync};
}
