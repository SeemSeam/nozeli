import {viewportWindowEnvironment} from './local-window.mjs';

// Positions are unscaled coordinates on the resolved source page, not pixels
// in the current viewport. Source visibility never changes durable hide state.
export function sourcePageWindowEnvironment(layer, getGeometry, options) {
  const viewport = viewportWindowEnvironment(layer, options);
  const project = (rect, frame) => {
    const g=frame.source;
    return g ? {x:g.pageRect.left+rect.x*g.scaleX,y:g.pageRect.top+rect.y*g.scaleY,width:rect.width*g.scaleX,height:rect.height*g.scaleY} : rect;
  };
  return {
    coordinateSpace:'source-page',
    measure() {
      const base=viewport.measure(),g=getGeometry();
      if(!g)return {...base,bounds:{x:0,y:0,width:0,height:0},visible:false};
      const {pageRect:p,pageSize:s,viewportRect:v,anchorRect:a}=g;
      const scaleX=p.width/s.width,scaleY=p.height/s.height;
      return {...base,bounds:{x:0,y:0,width:s.width,height:s.height},
        defaultRect:{x:(a.left-p.left)/scaleX+8,y:(a.top-p.top)/scaleY,width:380,height:380},
        visible:p.left+p.width>v.left&&p.left<v.right&&p.top+p.height>v.top&&p.top<v.bottom,
        source:{...g,scaleX,scaleY}};
    },
    toLocal(x,y) {
      const g=getGeometry();
      return g ? {x:(x-g.pageRect.left)*g.pageSize.width/g.pageRect.width,y:(y-g.pageRect.top)*g.pageSize.height/g.pageRect.height} : {x,y};
    },
    paintRect:project,
    clipRect:frame=>frame.source?.viewportRect,
    // A legacy viewport position has no reliable page offset: retain it in the
    // host migration receipt and reopen near the actual source, not another page.
    migrateView(view,frame) {
      if(!frame.source||view.schema===2&&view.placement.space==='source-page')return null;
      return {...view,schema:2,placement:{mode:'auto',space:'source-page'},size:view.size?{width:view.size.width/frame.source.scaleX,height:view.size.height/frame.source.scaleY}:null};
    },
    subscribe:viewport.subscribe,
  };
}
