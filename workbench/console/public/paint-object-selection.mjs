// Object clicks have a separate active item; changing it must not toggle away a selected peer.
export function objectClickSelection(selected,active,clicked,extend=false){
  if(!extend)return {selected:[clicked],active:clicked};
  if(!selected.includes(clicked))return {selected:[...selected,clicked],active:clicked};
  if(clicked!==active)return {selected:[...selected],active:clicked};
  const remaining=selected.filter(item=>item!==clicked);
  return {selected:remaining,active:remaining.at(-1)??null};
}
