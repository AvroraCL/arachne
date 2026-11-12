import {paintChannels} from './public/paint-channels.mjs';
import {modelTemplates} from './public/model-templates.mjs';
import {APP_VERSION} from './public/app-version.mjs';
import {nodeTypes,brushNodeTypes} from './public/material-graph.mjs';
import {cyclesLimits} from './public/cycles-limits.mjs';
import {cyclesLightPaths} from './public/cycles-light-paths.mjs';
import {cyclesRenderPasses} from './public/cycles-render-passes.mjs';
import {renderTransforms,renderLooks,renderAppearanceLimits} from './public/render-appearance.mjs';
import {renderLightingPresets,renderLightingLimits,renderLightLimit,renderLightRanges} from './public/render-lighting.mjs';
import {renderOpticsFields} from './public/render-optics.mjs';
import {renderBookmarkLimit} from './public/paint-delivery-options.mjs';
import {uvRegionLimits,maxUVFeather} from './public/uv-selection-region.mjs';
import {imageAdjustments} from './public/image-adjustments.mjs';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';

const port=Number(process.env.ARACHNE_PORT||8766);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('无效的本机端口');
const base='http://127.0.0.1:'+port,writable=process.argv.includes('--write');
const string={type:'string'},revision={type:'integer',minimum:0},id={type:'string',pattern:'^[\\w-]{1,100}$'};
const edit={projectId:id,revision};
const tuple=(size,minimum,maximum)=>({type:'array',items:{type:'number',minimum,maximum},minItems:size,maxItems:size});
const number=(minimum,maximum)=>({type:'number',minimum,maximum});
const integer=(minimum,maximum)=>({type:'integer',minimum,maximum});
const camera={type:['object','null'],additionalProperties:false,
  required:['projection','eye','target','up'],properties:{
    projection:{enum:['perspective','orthographic']},eye:tuple(3,-1e6,1e6),target:tuple(3,-1e6,1e6),up:tuple(3,-1e6,1e6),
    fov:number(5,120),orthoHeight:number(.00001,1e6)
  }};
const lightPaths={type:'object',additionalProperties:false,required:Object.keys(cyclesLightPaths),
  properties:Object.fromEntries(Object.entries(cyclesLightPaths).map(([key,spec])=>[key,typeof spec.default==='boolean'?
    {type:'boolean'}:(spec.step===1?integer:number)(spec.min,spec.max)]))};
const renderSettings={type:'object',additionalProperties:false,properties:{
  width:integer(cyclesLimits.minDimension,cyclesLimits.maxDimension),height:integer(cyclesLimits.minDimension,cyclesLimits.maxDimension),
  samples:integer(1,cyclesLimits.maxSamples),device:{enum:['auto','cpu','gpu']},denoise:{type:'boolean'},adaptive:{type:'boolean'},
  noiseThreshold:number(0,1),maxBounces:integer(0,64),transparent:{type:'boolean'},
  fileFormat:{enum:['PNG','OPEN_EXR']},bitDepth:{enum:[8,16,32],description:'PNG：8 或 16；OpenEXR：16（半精度）或 32（单精度）'},camera,lightPaths,
  renderPasses:{type:'array',items:{enum:Object.keys(cyclesRenderPasses)},uniqueItems:true,maxItems:Object.keys(cyclesRenderPasses).length}
}};
const renderAppearance={type:['object','null'],additionalProperties:false,required:['viewTransform','look','exposure','gamma'],properties:{
  viewTransform:{enum:Object.keys(renderTransforms)},look:{enum:renderLooks('AgX')},
  exposure:number(...renderAppearanceLimits.exposure),gamma:number(...renderAppearanceLimits.gamma)
}};
const renderLighting={type:['object','null'],additionalProperties:false,required:['preset','lightStrength','environmentStrength','rotation','environmentColor'],properties:{
  preset:{enum:Object.keys(renderLightingPresets)},lightStrength:number(...renderLightingLimits.lightStrength),
  environmentStrength:number(...renderLightingLimits.environmentStrength),rotation:number(...renderLightingLimits.rotation),
  environmentColor:{type:'string',pattern:'^#[0-9a-fA-F]{6}$'},
  lights:{type:'array',maxItems:renderLightLimit,items:{
    type:'object',additionalProperties:false,required:['id','name','enabled','position','intensity','width','height','color'],properties:{
      id,name:{type:'string',minLength:1,maxLength:60},enabled:{type:'boolean'},
      position:tuple(3,...renderLightRanges.position),intensity:number(...renderLightRanges.intensity),
      width:number(...renderLightRanges.size),height:number(...renderLightRanges.size),color:{type:'string',pattern:'^#[0-9a-fA-F]{6}$'}
    }
  }}
}};
const renderOptics={type:['object','null'],additionalProperties:false,required:['enabled','focusMode',...Object.keys(renderOpticsFields)],properties:{
  enabled:{type:'boolean'},focusMode:{enum:['target','distance']},
  ...Object.fromEntries(Object.entries(renderOpticsFields).map(([key,limits])=>[key,(key==='blades'?integer:number)(...limits)]))
}};
const renderRegion={type:['object','null'],additionalProperties:false,required:['enabled','crop','x0','y0','x1','y1'],properties:{
  enabled:{type:'boolean'},crop:{type:'boolean'},x0:number(0,1),y0:number(0,1),x1:number(0,1),y1:number(0,1)
}};
const presetProperties=Object.fromEntries(Object.entries(renderSettings.properties).filter(([key])=>!['device','camera'].includes(key)));
const renderPreset={type:['object','null'],additionalProperties:false,properties:{
  ...presetProperties,version:{const:1},framing:{enum:['auto','saved']},bitDepth:{enum:[null,8,16,32]}
},required:[...Object.keys(presetProperties).filter(key=>!['lightPaths','renderPasses'].includes(key)),'version','framing']};
const uvRect=tuple(4,0,1);
const uvPolygon={type:'array',items:tuple(2,0,1),minItems:3,maxItems:256,
  description:'可选套索顶点，沿边界依次排列，位于选区包围框内'};
const uvRegions={type:'array',minItems:1,maxItems:uvRegionLimits.rings,
  items:{type:'array',minItems:1,maxItems:uvRegionLimits.rings,
    items:{type:'array',items:tuple(2,0,1),minItems:3,maxItems:uvRegionLimits.points}},
  description:'组合选区，每项是一个多边形的外轮廓及其孔洞。与 polygon 互斥，所有坐标位于选区包围框内。'};
const uvFeather={type:'integer',minimum:0,maximum:maxUVFeather,description:'按 4096² 图像计算的选区羽化半径，单位为像素'};
const canvasPlacement={type:'object',additionalProperties:false,required:['x','y'],properties:{
  x:{type:'number',minimum:0,maximum:1,description:'从画布左边起的比例'},
  y:{type:'number',minimum:0,maximum:1,description:'从画布顶边起的比例'},
  parentId:{type:['string','null'],description:'目标文件夹，null 为顶层'}
}};

const uvTransform={
  type:'object',
  properties:{
    rect:{...uvRect,description:'画布左上角为原点的 [左,上,右,下]，归一化到 0–1'},
    polygon:uvPolygon,regions:uvRegions,feather:uvFeather,
    offset:{...tuple(2,-2,2),description:'按整张贴图宽高归一化的 [水平,垂直] 位移'},
    scale:{...tuple(2,-8,8),description:'[水平,垂直] 缩放倍数，绝对值至少 .05，负数翻转对应方向'},
    angle:{type:'number',minimum:-360,maximum:360,description:'顺时针角度，围绕原选区中心旋转'},
    copy:{type:'boolean',description:'为 true 时保留选区原位置的笔触'},
    interpolation:{enum:['linear','nearest'],description:'默认线性采样，nearest 保留像素硬边'}
  },
  required:['rect','offset','scale','angle'],
  additionalProperties:false
};
const tools=[
  ['material_nodes','读取节点类型、输入输出插口和默认参数',{},[],false],
  ['projects','列出工程及修订',{},[],false],
  ['personal_list','列出本机跨项目个人资源及个人库修订',{},[],false],
  ['personal_save','把当前项目资源及图片依赖复制到个人库，不修改源工程',{...edit,personalRevision:revision,kind:{enum:['materials','brushes','images']},resourceId:id},['projectId','revision','personalRevision','kind','resourceId'],true],
  ['personal_import','从个人库导入独立项目副本，生成一个工程修订',{...edit,personalRevision:revision,resourceId:id},['projectId','revision','personalRevision','resourceId'],true],
  ['personal_rename','重命名个人资源，不影响已导入的项目副本',{personalRevision:revision,resourceId:id,name:string},['personalRevision','resourceId','name'],true],
  ['personal_remove','删除个人资源条目，不影响项目副本',{personalRevision:revision,resourceId:id},['personalRevision','resourceId'],true],
  ['history','读取可撤销/重做的历史动作和步数',{projectId:id},['projectId'],false],
  ['get','读取涂装工程、当前修订和诊断任务',{projectId:id},['projectId'],false],
  ['create','从示例模型、基础几何模板或已登记模型创建涂装工程',{name:string,sourceProjectId:id,modelTemplate:{enum:Object.keys(modelTemplates)}},[],true],
  ['import_png','导入本机 PNG。可用 placement 放置画布图层，或用 nodeId 绑定已有图像节点，二者互斥；素材与目标写入同一修订',{
    ...edit,file:string,name:string,placement:canvasPlacement,nodeId:id,materialId:id
  },['projectId','revision','file'],true],
  ['text','新建或编辑二维文字层。新建用 placement，编辑用 layerId。文字和透明 PNG 共用一个修订',{
    ...edit,placement:canvasPlacement,layerId:id,text:{
      type:'object',additionalProperties:false,required:['content','color','fontSize','weight','align'],
      properties:{
        content:{type:'string',maxLength:480},color:{type:'string',pattern:'^#[0-9a-fA-F]{6}$'},
        fontSize:{type:'integer',minimum:16,maximum:512},weight:{enum:[400,700]},align:{enum:['left','center','right']}
      }
    }
  },['projectId','revision','text'],true],
  ['edit',[
    'renderCamera 用 camera 保存工程相机；renderAppearance 用 appearance 保存色彩管理；renderLighting 用 lighting 保存布光；renderPreset 用 preset 保存输出和采样。对应字段传 null 可清除。设置与其他工程命令共用修订与撤销。',
    'renderBookmark 用 id、action:add/update/remove 和 patch:{name,camera} 管理相机书签，可用 paint_render_batch 按书签出图。',
    'renderVisibility 用 visibility:{源物体名称:boolean} 修改对象渲染显隐，false 从渲染排除；用 paint_render_objects 读取已登记源物体。修改随工程保存，不影响视口小眼睛。',
    'renderOptics 用 optics 修改工程相机景深，target 对焦相机目标点，distance 使用手动距离。null 恢复源相机。',
    'renderRegion 用 region 设定相机取景框从左上角起的归一化矩形；crop 为 true 时裁切成品，null 清除。',
    'shader 用 graph 替换完整节点材质，graph:null 还原普通涂装。version:1，material:f_16xl，nodes:[{id,type,x,y,params}]，links:[{from:{node,port},to:{node,port}}]。支持 paint/color/value/uv/mapping/image/mix/math/ramp/pbr/output，同类型插口连接，禁止循环。与图层命令共用原子批次及修订。',
    'library 用 library:materials/brushes、id、action:create/update/remove 和 patch:{name,graph} 管理资源。材质图禁用 paint 源节点；笔刷图 material:brush，支持 value/math/brush/output，brush 输出接 output.brush。填充层 patch.materialId 引用材质 ID，null 解除。',
    '独立图像文档使用 op:image、documentId 和 action:create/update/remove/addLayer/updateLayer/removeLayer/duplicateLayer/moveLayer/stroke/transform/clear/bind。create 的 patch:{name,colorSpace:srgb/linear}，文档固定4096²。addLayer 用 layerId 和 kind:pixel/image/gradient，图片层 patch.asset 引用素材。渐变用 patch.gradient:{kind:linear/radial,start:[u,v],end:[u,v],colors:[HEX,HEX],alpha:[0–1,0–1]}，坐标从左上角归一化，可传 clip 与 polygon。updateLayer 用同结构的 maskGradient 写入灰度蒙版，null 移除渐变。stroke 用 layerId、target:pixels/mask 和二维 stroke；pixels 只保存 color/erase。bind 用 channel 和 materialLayerId，或 newLayerId 新建独立填充层。图像与材质命令共用修订及原子撤销。',
    'op:image、action:duplicate、documentId 和 newDocumentId 可复制整张贴图，保留图层、笔触、蒙版与色彩空间。已有材质引用继续指向原文档。',
    '图像蒙版用 action:createMask、layerId 与 reveal:boolean 创建，可加 rect 和选区轮廓。transferMask 用 sourceLayerId 和目标 layerId 在同文档转移蒙版，copy:true 复制。反相和删除使用 invertMask 和 removeMask。',
    '剪贴蒙版用 action:setClipping、layerId 和 clipped:true 创建。连续的剪贴层沿用最近的下方底层透明度，clipped:false 释放选中层及其上方连续剪贴层。',
    '调整图层用 op:image、action:addLayer、kind:adjustment 和 patch.adjustment 创建。可用 updateLayer 修改。支持 '+Object.keys(imageAdjustments).join('、')+'，影响下方图层，并可使用蒙版和不透明度。',
    '二维图像笔刷可同时指定 flow（0.01–1）与 spacing（笔尖直径的 0.05–2 倍）。这时 stamps 表示连续轨迹，按图像空间的固定间距盖印，并在单笔 opacity 上限内逐步积累流量。breaks 可指定提笔后新轨迹段的起始下标。',
    '油漆桶用 action:stroke、target:pixels 和 stroke:{uv:true,color,erase:false,opacity,flood:{point:[u,v],tolerance,contiguous}}。容差为 0–255，取样当前层该笔之前的像素，可用 clip、regions 和 feather 限制写入。',
    '仿制笔触在二维像素笔刷参数上追加 clone:{offset:[du,dv]}，相对目标位置取样当前层落笔前的 RGBA 像素。偏移归一化到 −1 至 1，可按相同偏移继续后续笔触。',
    '像素层的 updateLayer patch.alphaLocked 开启透明像素锁。随后绘制、填充和仿制只改颜色，保留原始透明度。蒙版可独立编辑。',
    '形状图层用 action:addLayer、kind:shape 和 patch:{x,y,scale,rotation,stretch,shape:{kind,width,height,fill,stroke,strokeWidth,cornerRadius}}。形状 kind 为 rectangle 或 ellipse，宽高与描边圆角按文档像素计，fill、stroke 为十六进制颜色或 null。可用 updateLayer 继续修改。',
    '原子图层命令。add 用 kind/patch，可用 parentId 指定文件夹。group 用 id 或同级 ids 收进新文件夹。arrange 用 id 或同级 ids 与 parentId/anchorId/placement 移动图层，parentId 为 null 时移到根层。remove 可解散文件夹，保留子层。base/update 用 patch，move 用 index，duplicate 用 id。图层顺序从底到顶。',
    'update 的 patch.locked 锁定图层或文件夹。文件夹锁覆盖子层，仍可切换显隐。锁定冲突会拒绝整批命令。',
    '三维贴花 patch.projector 为 {center,normal,up,size,depth,rotation}，坐标使用 Blender 世界坐标，normal 朝投影来源。',
    '画布图片使用 kind:decal 和 patch:{space:"uv",image,x,y,scale,rotation}。x/y 从画布左上角归一化，scale 是图片长边占整张贴图的比例。uvScale 是独立的 [水平,垂直] 倍数，负数翻转对应方向。',
    'baseChannels 用 patch:{通道名:boolean} 启用／关闭底层通道，保留已存参数；底层关闭时使用中性默认值，上方图层继续正常合成。图层通道通过 update 的 patch.channels 修改。stroke 用 id、target、stroke，笔触含 {radius,hardness,opacity,stamps}。三维 stamp 为 [x,y,z,nx,ny,nz]，末尾可追加 pressure，也可用 mirrorX:true 沿 Blender X=0 镜像。二维笔触指定 uv:true，stamp 为从画布左上角归一化的 [u,v] 或 [u,v,pressure]。pressure 为 0–1 的强度系数。二维半径为整张贴图宽度的比例，clip:[左,上,右,下] 限制写入范围。材质笔触另需 {values,channels,erase}；values 和 channels 支持 color、metallic、roughness、normal、height、emission、alpha、ao，前三项为兼容必需字段，扩展项可选。color/emission 为 sRGB 十六进制颜色，normal 为 OpenGL 切线法线的线性 RGB 十六进制编码，其余值为 0–1。height 用于凹凸而非几何置换，alpha 与整层 opacity 分开；蒙版笔触另需 value（0 遮盖、1 恢复）。均匀填充可传 {uv:true,rect:[左,上,右,下],opacity} 及对应通道与材质值或蒙版值。笔刷裁切和填充都可追加 polygon 顶点数组作为套索。',
    '按几何填充蒙版可传 {region,hit,value,opacity}，region 为 triangle、polygon、mesh 或 island，hit 格式同一个三维 stamp。maskBase 为 0–1，maskEnabled 可停用蒙版。maskEffects 按数组顺序应用，支持 invert、levels {black,white,gamma}、height/facing {axis,center,feather,blend}、edgeWear {edge:convex/concave/both,angle,width,softness,blend}、surfaceNoise {scale,threshold,softness,seed,blend}。每项都有 kind/enabled/opacity，edgeWear.width 为模型尺寸百分比。',
    'transformUV 用 id 与 transform 移动、旋转、缩放、翻转或复制当前绘制层在选区内的笔触。clearUV 用 id 和 rect 清除选区内已有的材质笔触。两者都可追加 polygon 顶点数组，保留套索外的内容。',
    '选区可用 regions 描述多个区域和孔洞。每个多边形包含一个外轮廓与可选的孔洞轮廓。可追加 feather（0–256 像素）设置软边，用于笔触、填充、渐变、清除、变换与新建蒙版。'
  ].join('\n'),{
    ...edit,operations:{type:'array',items:{type:'object',properties:{op:{enum:['base','baseChannels','add','update','move','remove','duplicate','stroke','group','arrange','transformUV','clearUV','shader','library','image','renderCamera','renderBookmark','renderAppearance','renderLighting','renderPreset','renderVisibility','renderOptics','renderRegion']},camera,appearance:renderAppearance,lighting:renderLighting,preset:renderPreset,optics:renderOptics,region:renderRegion,visibility:{type:'object',minProperties:1,maxProperties:4096,additionalProperties:{type:'boolean'}},graph:{type:['object','null']},library:{enum:['materials','brushes']},action:{enum:['add','create','update','remove','duplicate','addLayer','updateLayer','removeLayer','duplicateLayer','moveLayer','stroke','transform','clear','bind','createMask','transferMask','invertMask','removeMask','setClipping']},documentId:id,newDocumentId:id,layerId:id,newLayerId:id,materialLayerId:id,sourceLayerId:id,reveal:{type:'boolean'},copy:{type:'boolean'},clipped:{type:'boolean'},channel:{enum:paintChannels},id,ids:{type:'array',items:id,minItems:1,maxItems:64,uniqueItems:true},
      kind:{enum:['fill','decal','paint','group','pixel','image','gradient','adjustment','shape']},parentId:{type:['string','null']},anchorId:{type:['string','null']},
      placement:{enum:['above','below']},index:{type:'integer'},patch:{type:'object'},
      target:{enum:['material','mask','pixels']},stroke:{type:'object'},transform:uvTransform,rect:uvRect,polygon:uvPolygon,regions:uvRegions,feather:uvFeather},required:['op']},minItems:1}
  },['projectId','revision','operations'],true],
  ['undo','撤销一个或多个步骤，只生成一个工程修订',{...edit,steps:{type:'integer',minimum:1,maximum:50}},['projectId','revision'],true],
  ['redo','重做一个或多个步骤，只生成一个工程修订',{...edit,steps:{type:'integer',minimum:1,maximum:50}},['projectId','revision'],true],
  ['preview','为当前修订启动八通道预览',edit,['projectId','revision'],true],
  ['render_devices','读取本机 Blender 版本、CPU 和兼容的 Cycles GPU',{},[],false],
  ['render_objects','读取已登记场景的原始物体名称和渲染开关。工程覆盖可从 paint_get 获取。',{projectId:id},['projectId'],false],
  ['render','以当前工程修订通过路径追踪导出 8 位 PNG 或 16/32 位浮点 OpenEXR。可指定工程相机，或使用工程保存的渲染预设；使用预设时 settings 只可覆盖本机 device。用 paint_job 查询进度、原片和报告。',
    {...edit,settings:renderSettings,useProjectCamera:{type:'boolean'},useProjectPreset:{type:'boolean'},requestId:id},['projectId','revision'],true],
  ['render_batch','使用一个冻结修订按相机书签批量出图。settings 传输出尺寸、采样和格式，省略 camera。',
    {...edit,settings:renderSettings,bookmarkIds:{type:'array',items:id,minItems:1,maxItems:renderBookmarkLimit,uniqueItems:true},requestId:id},
    ['projectId','revision','bookmarkIds'],true],
  ['render_cancel','取消指定出图任务',{...edit,jobId:id},['projectId','revision','jobId'],true],
  ['render_retry','按原工程快照和原渲染设置重试失败或取消的路径追踪出图',{...edit,jobId:id,requestId:id},['projectId','revision','jobId'],true],
  ['job','查询任务、进度与诊断结果；文件链接相对于本机服务',{projectId:id,jobId:id},['projectId','jobId'],false],
].map(([name,description,properties,required,write])=>({
  name:'paint_'+name,description,inputSchema:{type:'object',properties,required,additionalProperties:false},write
}));

async function request(url,data){
  const response=await fetch(base+url,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const value=await response.json();
  if(!response.ok)throw Error(JSON.stringify(value));
  return value;
}
const safe=s=>{if(typeof s!=='string'||!/^[-\w]{1,100}$/.test(s))throw Error('无效的工程或任务 ID');return s;};
async function call(name,args){
  const tool=tools.find(t=>t.name===name);
  if(!tool)throw Error('未知制作工具');
  if(tool.write&&!writable)throw Error('MCP 以只读模式启动');
  if(name==='paint_material_nodes')return {version:1,material:'f_16xl',nodeTypes,brushNodeTypes};
  if(name==='paint_render_devices')return request('/api/cycles-devices');
  if(name==='paint_projects')return request('/api/projects');
  if(name==='paint_personal_list')return request('/api/personal-library');
  if(name==='paint_personal_save')return request('/api/personal-library/save',{projectId:safe(args.projectId),projectRevision:args.revision,revision:args.personalRevision,kind:args.kind,resourceId:safe(args.resourceId)});
  if(name==='paint_personal_rename'||name==='paint_personal_remove')return request('/api/personal-library/'+name.slice('paint_personal_'.length),{revision:args.personalRevision,id:safe(args.resourceId),...(name==='paint_personal_rename'?{name:args.name}:{})});
  if(name==='paint_create')return request('/api/projects',{workflowType:'pbr_paint',name:args.name,sourceProjectId:args.sourceProjectId,modelTemplate:args.modelTemplate});
  const root='/api/projects/'+safe(args.projectId);
  if(name==='paint_personal_import')return request(root+'/paint/library-import',{revision:args.revision,libraryRevision:args.personalRevision,id:safe(args.resourceId)});
  if(name==='paint_history')return request(root+'/paint/history');
  if(name==='paint_get')return request(root+'/paint');
  if(name==='paint_render_objects')return request(root+'/paint/render-objects');
  if(name==='paint_job')return request(root+'/jobs/'+safe(args.jobId));
  const data={revision:args.revision};
  const operation=name.slice('paint_'.length);
  if(operation==='render')return request(root+'/paint/render',{...data,settings:args.settings,useProjectCamera:args.useProjectCamera,useProjectPreset:args.useProjectPreset,requestId:args.requestId??crypto.randomUUID()});
  if(operation==='render_batch')return request(root+'/paint/render-batch',{...data,settings:args.settings,bookmarkIds:args.bookmarkIds,requestId:args.requestId??crypto.randomUUID()});
  if(operation==='render_cancel')return request(root+'/paint/render-cancel',{...data,jobId:safe(args.jobId)});
  if(operation==='render_retry')return request(root+'/paint/render-retry',{...data,jobId:safe(args.jobId),requestId:args.requestId??crypto.randomUUID()});
  if(operation==='import_png'){
    if(!path.isAbsolute(args.file)||path.extname(args.file).toLowerCase()!=='.png')throw Error('请提供 PNG 的本机绝对路径');
    const stat=fs.statSync(args.file);
    if(!stat.isFile()||stat.size>24*1024*1024)throw Error('PNG 文件无效或超过 24 MiB');
    return request(root+'/paint/assets',{...data,name:args.name||path.basename(args.file),placement:args.placement,nodeId:args.nodeId,materialId:args.materialId,
      data:fs.readFileSync(args.file).toString('base64')});
  }
  if(operation==='edit')return request(root+'/paint/commands',{...data,operations:args.operations});
  if(operation==='text')return request(root+'/paint/text',{...data,text:args.text,placement:args.placement,layerId:args.layerId});
  return request(root+'/paint/'+operation,{...data,...(['undo','redo'].includes(operation)?{steps:args.steps}:{}),requestId:crypto.randomUUID()});
}
const supported=['2025-11-25','2025-06-18','2025-03-26','2024-11-05'];
let initialized=false;
async function dispatch({method,params,id}){
  if(id===undefined)return;
  const respond=result=>({jsonrpc:'2.0',id,result});
  if(method==='initialize'){
    initialized=true;
    return respond({protocolVersion:supported.includes(params?.protocolVersion)?params.protocolVersion:supported[0],
      capabilities:{tools:{}},serverInfo:{name:'arachne-web-paint',version:APP_VERSION}});
  }
  if(method==='ping')return respond({});
  if(initialized&&method==='tools/list')return respond({tools:tools.map(({write,...tool})=>tool)});
  if(initialized&&method==='tools/call'){
    try{
      const value=await call(params?.name,params?.arguments||{});
      return respond({content:[{type:'text',text:JSON.stringify(value)}]});
    }catch(error){return respond({isError:true,content:[{type:'text',text:error.message}]});}
  }
  return {jsonrpc:'2.0',id,error:{code:initialized?-32601:-32002,message:initialized?'Method not found':'Server not initialized'}};
}
for await(const line of readline.createInterface({input:process.stdin})){
  let result;
  try{result=await dispatch(JSON.parse(line));}
  catch{result={jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}};}
  if(result)process.stdout.write(JSON.stringify(result)+'\n');
}
