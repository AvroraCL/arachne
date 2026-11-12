export const unavailableStrokeJournal='此窗口无法写入恢复草稿。请保留窗口并重试保存。';

export function createStrokeDraftJournal(key){
  let unavailable=false;
  return {
    read(id){try{return JSON.parse(sessionStorage.getItem(key(id)));}catch{return null;}},
    write(id,draft){
      if(!id)return;
      try{
        if(draft)sessionStorage.setItem(key(id),JSON.stringify(draft));
        else sessionStorage.removeItem(key(id));
        unavailable=false;
      }catch{unavailable=!!draft;}
    },
    get unavailable(){return unavailable;}
  };
}
