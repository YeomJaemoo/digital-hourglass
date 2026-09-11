// Coordinates are identical in both renderers: module 0 = lower, 1 = upper.
export const LED_CELLS = Object.freeze(Array.from({length:128}, (_,i) => {
  const module=i>>6,row=(i>>3)&7,col=i&7;
  return Object.freeze({module,row,col,x:(row-col)*.103,y:(module===1?.87:-.87)-(row+col-7)*.103});
}));
const rgb = hex => [1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255);
const tint = (c,k,a=1) => [...c.map(v=>v*k),a];

// A small triangle renderer: shaded solids, translucent cover, emissive LED lenses.
class WebGLRenderer {
  constructor(canvas) {
    const gl=canvas.getContext('webgl',{alpha:true,antialias:true,premultipliedAlpha:false});
    if(!gl) throw new Error('WebGL unavailable');
    this.gl=gl;this.canvas=canvas;
    const shader=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);
      if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s;};
    const vertex=shader(gl.VERTEX_SHADER,`attribute vec3 position;attribute vec4 color;
      uniform float angle;uniform float view;uniform float aspect;varying vec4 vColor;
      void main(){float c=cos(angle),s=sin(angle);vec3 p=position;
      p.xy=mat2(c,s,-s,c)*p.xy;
      p.xz=mat2(cos(view),-sin(view),sin(view),cos(view))*p.xz;
      p.yz=mat2(cos(-.08),-sin(-.08),sin(-.08),cos(-.08))*p.yz;
      float w=5.5-p.z;gl_Position=vec4(p.x*2.25/aspect,p.y*2.25,-p.z,w);vColor=color;}`);
    const fragment=shader(gl.FRAGMENT_SHADER,`precision mediump float;varying vec4 vColor;void main(){gl_FragColor=vColor;}`);
    const program=gl.createProgram();gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));
    gl.deleteShader(vertex);gl.deleteShader(fragment);gl.useProgram(program);
    this.program=program;this.buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);
    for(const [name,size,offset] of [['position',3,0],['color',4,12]]) {
      const loc=gl.getAttribLocation(program,name);gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,size,gl.FLOAT,false,28,offset);
    }
    this.uniforms=Object.fromEntries(['angle','view','aspect'].map(n=>[n,gl.getUniformLocation(program,n)]));
    gl.enable(gl.DEPTH_TEST);gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
  }
  draw({snapshot,stale,angle,colors,time,reduced}) {
    const {gl,canvas}=this;if(gl.isContextLost())return;
    const size=Math.max(1,Math.round(canvas.clientWidth*Math.min(devicePixelRatio||1,2)));
    const height=Math.max(1,Math.round(canvas.clientHeight*Math.min(devicePixelRatio||1,2)));
    if(canvas.width!==size||canvas.height!==height){canvas.width=size;canvas.height=height;}
    gl.viewport(0,0,size,height);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    gl.uniform1f(this.uniforms.angle,-angle);
    // Fixed presentation perspective, never an invented sensor yaw/front-back measurement.
    gl.uniform1f(this.uniforms.view,.24+(!snapshot&&!reduced?.055*Math.sin(time/2400):0));
    gl.uniform1f(this.uniforms.aspect,size/height);
    const solid=[],transparent=[],glow=[];
    const tri=(list,a,b,c,color)=>{for(const p of [a,b,c])list.push(...p,...color);};
    const quad=(list,a,b,c,d,color)=>{tri(list,a,b,c,color);tri(list,a,c,d,color);};
    const face=(list,points,z,color)=>quad(list,...points.map(([x,y])=>[x,y,z]),color);
    const diamond=(cy,r)=>[[0,cy+r],[r,cy],[0,cy-r],[-r,cy]];
    const prism=(points,z0,z1,color)=>{
      face(solid,points,z0,tint(color,.5));face(solid,points,z1,tint(color,1));
      for(let i=0;i<4;i++){const a=points[i],b=points[(i+1)%4];quad(solid,[...a,z0],[...b,z0],[...b,z1],[...a,z1],tint(color,[.8,.45,.55,1.3][i]));}
    };
    const beam=(a,b,width,z0,z1,color)=>{
      const dx=b[0]-a[0],dy=b[1]-a[1],l=Math.hypot(dx,dy),x=-dy/l*width/2,y=dx/l*width/2;
      prism([[a[0]+x,a[1]+y],[b[0]+x,b[1]+y],[b[0]-x,b[1]-y],[a[0]-x,a[1]-y]],z0,z1,color);
    };
    const disk=(list,x,y,z,r,color,edge=color)=>{
      for(let n=0;n<16;n++){
        const a=n*Math.PI/8,b=(n+1)*Math.PI/8;
        list.push(x,y,z,...color,x+Math.cos(a)*r,y+Math.sin(a)*r,z,...edge,x+Math.cos(b)*r,y+Math.sin(b)*r,z,...edge);
      }
    };
    for(let m=0;m<2;m++) {
      const cy=m===1?.87:-.87,c=rgb(colors[m]);
      prism(diamond(cy,.83),-.16,.015,[.08,.105,.087]);
      const points=diamond(cy,.87);
      for(let i=0;i<4;i++)beam(points[i],points[(i+1)%4],.042,-.19,.18,[.31,.35,.29]);
      // A lightly tinted glass cover, raised over the LED board.
      face(transparent,diamond(cy,.825),.145,[...c,.025]);
      // Glass edge facets and a narrow reflection pick up the selected module color.
      const cover=diamond(cy,.825);
      for(let i=0;i<4;i++) {
        const a=cover[i],b=cover[(i+1)%4];
        quad(transparent,[...a,.04],[...b,.04],[...b,.145],[...a,.145],[...c,.1]);
      }
      quad(transparent,[-.58,cy+.13,.151],[-.1,cy+.61,.151],[-.075,cy+.57,.151],[-.54,cy+.105,.151],[...c,.11]);
      beam([-.76,cy+.035],[-.05,cy+.745],.009,.147,.149,[.39,.45,.4]);
      disk(solid,0,cy+.805,.19,.017,[.55,.57,.49,1]);
      disk(solid,0,cy-.805,.19,.017,[.55,.57,.49,1]);
    }
    prism([[-.085,.055],[.085,.055],[.085,-.055],[-.085,-.055]],-.12,.12,[.43,.45,.36]);
    for(const cell of LED_CELLS) {
      const {module:m,row,col,x,y}=cell,on=snapshot?.grid[m][row][col]??false,c=rgb(colors[m]);
      disk(solid,x+.006,y-.008,.021,.058,[.015,.023,.019,1]); // lens contact shadow
      disk(solid,x,y,.035,.05,on?tint(c,stale?.35:1):[.105,.135,.11,1]);
      if(on) {
        const peak=Math.max(...c);
        const core=c.map(v=>stale?v*.3+peak*.08:v*.32+peak*.68);
        disk(solid,x,y,.04,.036,[...core,1],tint(c,stale?.35:1));
        // Additive light, with a soft outer halo and a brighter inner bloom.
        disk(glow,x,y,.153,.105,tint(c,1,stale?.02:.24),tint(c,1,0));
        disk(glow,x,y,.154,.064,tint(c,1,stale?.035:.48),tint(c,1,0));
      }
    }
    const submit=(list)=>{gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(list),gl.DYNAMIC_DRAW);gl.drawArrays(gl.TRIANGLES,0,list.length/7);};
    gl.depthMask(true);submit(solid);gl.depthMask(false);submit(transparent);
    gl.blendFunc(gl.SRC_ALPHA,gl.ONE);submit(glow);
    gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);gl.depthMask(true);
  }
}

class FlatRenderer {
  constructor(canvas){this.canvas=canvas;this.ctx=canvas.getContext('2d');}
  draw({snapshot,stale,angle,colors}) {
    const c=this.ctx;if(!c)return;
    c.clearRect(0,0,800,800);c.save();c.translate(400,400);c.rotate(angle);
    for(let m=0;m<2;m++) {
      const cy=(m===1?-.87:.87)*190,r=.86*190;
      c.beginPath();c.moveTo(0,cy-r);c.lineTo(r,cy);c.lineTo(0,cy+r);c.lineTo(-r,cy);c.closePath();
      c.fillStyle='#17201a';c.fill();c.strokeStyle='#75816f';c.lineWidth=3;c.stroke();
    }
    for(const {module:m,row,col,x,y} of LED_CELLS){const on=snapshot?.grid[m][row][col]??false;
      c.globalAlpha=on&&stale?.4:1;c.fillStyle=on?colors[m]:'#334336';
      c.shadowColor=on?colors[m]:'transparent';c.shadowBlur=on&&!stale?18:0;
      c.beginPath();c.arc(x*190,-y*190,9.5,0,Math.PI*2);c.fill();
      if(on&&!stale){
        const color=rgb(colors[m]),peak=Math.max(...color);
        const core=color.map(v=>Math.round((v*.32+peak*.68)*255));
        const light=c.createRadialGradient(x*190,-y*190,0,x*190,-y*190,7);
        light.addColorStop(0,`rgb(${core.join(',')})`);light.addColorStop(1,colors[m]);
        c.fillStyle=light;c.shadowBlur=0;c.beginPath();c.arc(x*190,-y*190,7,0,Math.PI*2);c.fill();
      }
    }
    c.restore();
  }
}

export function createRenderer(canvas,onMode) {
  let active;
  const fallback=()=>{
    // A canvas with a WebGL context cannot subsequently provide a 2D context.
    const replacement=canvas.cloneNode(false);replacement.width=replacement.height=800;
    canvas.replaceWith(replacement);canvas=replacement;active=new FlatRenderer(canvas);
    canvas.dataset.renderer='2d';onMode('2D 대체 화면');
  };
  try{active=new WebGLRenderer(canvas);canvas.dataset.renderer='webgl';onMode('3D VIEW');
    canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();fallback();},{once:true});
  }catch{fallback();}
  return {draw:state=>active.draw(state)};
}
