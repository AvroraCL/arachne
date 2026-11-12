const projectId=id=>typeof id==='string'&&/^[\w-]{1,100}$/.test(id);
const vector=value=>Array.isArray(value)&&value.length===3&&value.every(Number.isFinite);
const validCamera=value=>value&&['perspective','orthographic'].includes(value.projection)&&
  vector(value.eye)&&vector(value.target)&&vector(value.up)&&
  Number.isFinite(value.fov)&&value.fov>0&&value.fov<180&&Number.isFinite(value.orthoHeight)&&value.orthoHeight>0;

export function createViewportProjectViews(state, legacyProject) {
  const views=new Map();
  function remember(id, view) {
    if(!projectId(id)||!validCamera(view?.camera))return;
    views.delete(id);
    views.set(id,{
      camera:view.camera,
      ...(view.cameraFrame?{cameraFrame:true}:{}),
      ...(view.projectCameraView?{projectCameraView:true}:{}),
      ...(validCamera(view.returnCamera)?{returnCamera:view.returnCamera}:{}),
      ...(view.cyclesPaused?{cyclesPaused:true}:{})
    });
    while(views.size>8)views.delete(views.keys().next().value);
  }
  for(const [id,view] of Object.entries(state.projectViews??{}))remember(id,view);
  if(!views.size)remember(legacyProject,state);
  return {read:id=>views.get(id),remember,snapshot:()=>Object.fromEntries(views)};
}
