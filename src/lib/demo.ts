import { defaultPlans, type Workspace, type Post } from './domain';
export const DEMO_KEY='threads-ai:demo:v1';
export function createDemo():Workspace {
  const now=new Date();
  const at=(days:number,hour:number)=>{const d=new Date(now);d.setUTCDate(d.getUTCDate()+days);d.setUTCHours(hour-8,0,0,0);return d.toISOString();};
  const seeds:[string,string,Post['status'],number,Post['platform']][]=[
    ['Consistency over perfection','Sometimes we wait too long for the perfect idea.\n\nIn reality, one small honest share today means more than a hundred ideas kept in your drafts.\n\nWhat is one lesson you learned this week?','scheduled',1,'both'],
    ['Behind the brand','People don\'t just buy products. They want to connect with the human behind them.\n\nShare a small behind-the-scenes moment from your journey today. That\'s what creates genuine resonance.','scheduled',2,'instagram'],
    ['3 tips for your next post','Stuck on what to write? Try these three prompts:\n\n1. Answer a question clients frequently ask.\n2. Share a mistake you overcame.\n3. Celebrate a small win.\n\nPick one and start today.','draft',3,'threads'],
    ['Build connection first','Great content sparks meaningful conversations.\n\nTalk less about what you sell. Share more about the problems you help solve.\n\nDo you agree?','published',-1,'both'],
    ['Weekend perspective','Take a pause. The best creative ideas often surface when you stop forcing them.\n\nHave a restful weekend!','draft',4,'threads'],
  ];
  return {
    profile:{name:'Alex Rivera',email:'alex@example.com',timezone:'Asia/Kuala_Lumpur',language:'English'},
    posts:seeds.map(([title,caption,status,day,platform],i)=>({id:`demo-${i+1}`,title,caption,platform,status,image_url:null,image_prompt:'',timezone:'Asia/Kuala_Lumpur',scheduled_at:status==='scheduled'?at(day,9):null,published_at:status==='published'?at(day,15):null,created_at:at(-3,10),updated_at:at(-1,10)})),
    account:{id:'demo-threads-account',platform:'threads',username:'alex.creates',status:'connected',expires_at:at(45,10)},
    instagramAccount:{id:'demo-ig-account',platform:'instagram',username:'alex.visuals',status:'connected',expires_at:at(45,10)},
    accounts:{
      threads:{id:'demo-threads-account',platform:'threads',username:'alex.creates',status:'connected',expires_at:at(45,10)},
      instagram:{id:'demo-ig-account',platform:'instagram',username:'alex.visuals',status:'connected',expires_at:at(45,10)}
    },
    subscription:{plan_id:'starter',status:'active',current_period_end:at(20,10)},
    usage:{copy_generations:8,image_generations:5,posts_published:1,estimated_cost:0},
    plans:defaultPlans,
    isAdmin:false
  };
}
