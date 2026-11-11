export function drawBrushPreview(canvas,settings){
  canvas.width=200;canvas.height=100;const c=canvas.getContext('2d');c.clearRect(0,0,200,100);
  const r=Math.min(22,Math.max(5,settings.uvRadius/5));
  for(let x=26;x<=176;x+=Math.max(2,r*.3)){
    c.save();c.translate(x,52-Math.sin((x-26)/150*Math.PI)*12);
    const gradient=c.createRadialGradient(0,0,Math.min(.999,settings.hardness)*r,0,0,r);
    gradient.addColorStop(0,`rgba(220,220,220,${settings.opacity})`);gradient.addColorStop(1,'rgba(220,220,220,0)');
    c.fillStyle=gradient;c.fillRect(-r,-r,r*2,r*2);c.restore();
  }
}
