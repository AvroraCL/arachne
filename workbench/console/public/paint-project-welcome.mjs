import {projectDate,recentProjects} from './paint-project-picker.mjs';

export function setupProjectWelcome({list,open}){
  const byId=id=>document.getElementById(id);
  const screen=byId('empty');
  const error=byId('welcome-error');
  const recent=byId('welcome-recent');
  const items=byId('welcome-recent-items');

  byId('welcome-new').onclick=()=>byId('new').click();
  byId('welcome-open').onclick=()=>byId('open-projects').click();
  byId('welcome-import').onclick=()=>byId('open-paint-import').click();

  async function refresh(problem){
    error.textContent=problem;
    try{
      const projects=recentProjects(await list()).slice(0,5);
      if(screen.hidden)return;
      items.replaceChildren(...projects.map(project=>{
        const item=document.createElement('li'),button=document.createElement('button');
        const name=document.createElement('span'),date=document.createElement('small');
        button.type='button';
        name.textContent=name.title=project.name;date.textContent=projectDate(project);
        button.append(name,date);item.append(button);
        button.onclick=async()=>{
          error.textContent='';
          if(!await open(project.id,error)&&!screen.hidden)await refresh(error.textContent);
        };
        return item;
      }));
      recent.hidden=!projects.length;
    }catch(failure){
      if(!screen.hidden)error.textContent=[problem,failure.message].filter(Boolean).join('。');
    }
  }
  return {refresh};
}
