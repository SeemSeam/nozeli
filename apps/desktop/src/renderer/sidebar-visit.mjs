// Sidebar openness is an intent for the current project visit, never business state.
export function createSidebarVisit(){
 let projectId=null,open=false;
 return {
  enter(next){next=next||null;if(next!==projectId){projectId=next;open=Boolean(next);}return open;},
  set(value){open=Boolean(projectId&&value);return open;},
  get projectId(){return projectId;},get open(){return open;}
 };
}
