// Mod is the application's primary shortcut modifier. Ctrl denotes a literal Control key.
export function menuShortcut(chord,platform=navigator.platform){
  const keys=chord.split('+'),key=keys.pop();
  if(/Mac|iPhone|iPad/.test(platform)){
    const modifiers=[['Ctrl','⌃'],['Shift','⇧'],['Alt','⌥'],['Mod','⌘']];
    return modifiers.filter(([name])=>keys.includes(name)).map(([,symbol])=>symbol).join('')+key;
  }
  return [...keys.map(name=>name==='Mod'?'Ctrl':name),key].join('+');
}
