const phases={
  source:'读取场景',materials:'绑定材质贴图',lighting:'准备场景布光',camera:'准备相机',device:'准备渲染设备',
  scene:'构建渲染场景',denoise:'降噪',composite:'合成',write:'保存图像',
  verify:'核对渲染结果',fallback:'GPU 渲染失败，切换至 CPU',complete:'渲染完成'
};

export function cyclesProgressLabel(progress){
  if(!progress)return '';
  const {phase,device,sample,total}=progress;
  if(phase==='sample')return [device,`采样 ${sample} / ${total}`].filter(Boolean).join(' · ');
  if(!phases[phase])return '';
  return phase==='fallback'?phases[phase]:[device,phases[phase]].filter(Boolean).join(' · ');
}
