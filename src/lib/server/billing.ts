import 'server-only';
import Stripe from 'stripe';
import { db,env,appUrl,checkDB,AppError,readBody } from './core';
export function stripe(){return new Stripe(env('STRIPE_SECRET_KEY'),{maxNetworkRetries:1,timeout:20_000});}
export function priceId(plan:string){const key:Record<string,string>={starter:'STRIPE_PRICE_STARTER',pro:'STRIPE_PRICE_PRO',business:'STRIPE_PRICE_BUSINESS'};if(!key[plan])throw new AppError('Pelan tidak sah.');return env(key[plan]);}
export async function checkout(userId:string,email:string,planId:string){
 const {data:existing,error}=await db().from('subscriptions').select('status,provider_customer_id').eq('user_id',userId).maybeSingle();checkDB(error);
 if(existing&&!['canceled','expired','incomplete_expired'].includes(existing.status))throw new AppError('Urus langganan sedia ada melalui portal bil.',409);
 const {data:plan,error:pe}=await db().from('plans').select('*').eq('id',planId).eq('active',true).single();checkDB(pe);if(!plan)throw new AppError('Pelan tidak tersedia.');
 const client=stripe();const price=await client.prices.retrieve(priceId(planId));
 if(!price.active||price.currency!=='myr'||price.recurring?.interval!=='month'||price.recurring.interval_count!==1||price.unit_amount!==Math.round(Number(plan.monthly_price)*100))throw new AppError('Harga checkout sedang dikemas kini. Sila cuba kemudian.',503,'price_mismatch');
 const reserved=await db().rpc('reserve_checkout',{p_user:userId,p_plan:planId});checkDB(reserved.error);
 if(!reserved.data){const pending=await db().from('billing_checkouts').select('plan_id,url').eq('user_id',userId).single();checkDB(pending.error);if(pending.data?.url&&pending.data.plan_id===planId)return {url:pending.data.url};throw new AppError('Satu checkout masih aktif. Selesaikan checkout sedia ada atau tunggu 31 minit sebelum memilih pelan lain.',409);}
 const session=await client.checkout.sessions.create({mode:'subscription',line_items:[{price:price.id,quantity:1}],...(existing?.provider_customer_id?{customer:existing.provider_customer_id}:{customer_email:email}),client_reference_id:userId,metadata:{user_id:userId,plan_id:planId},subscription_data:{metadata:{user_id:userId,plan_id:planId}},expires_at:Math.floor(Date.now()/1000)+1800,success_url:`${appUrl()}/billing?checkout=success`,cancel_url:`${appUrl()}/billing?checkout=cancelled`},{idempotencyKey:`checkout:${reserved.data}`});
 const saved=await db().from('billing_checkouts').update({session_id:session.id,url:session.url}).eq('user_id',userId).eq('attempt_id',reserved.data);checkDB(saved.error);return {url:session.url};
}
export async function portal(userId:string){const {data,error}=await db().from('subscriptions').select('provider_customer_id').eq('user_id',userId).maybeSingle();checkDB(error);if(!data?.provider_customer_id)throw new AppError('Tiada langganan untuk diuruskan.');const session=await stripe().billingPortal.sessions.create({customer:data.provider_customer_id,return_url:`${appUrl()}/billing`});return {url:session.url};}
export async function paymentWebhook(req:Request){
 const raw=await readBody(req,1_000_000);const signature=req.headers.get('stripe-signature');if(!signature)throw new AppError('Missing signature',400);
 const client=stripe();let event:Stripe.Event;try{event=client.webhooks.constructEvent(raw,signature,env('STRIPE_WEBHOOK_SECRET'));}catch{throw new AppError('Invalid webhook signature',400);}
 let subscriptionId:string|undefined;
 if(event.type==='checkout.session.completed'){const session=event.data.object as Stripe.Checkout.Session;subscriptionId=typeof session.subscription==='string'?session.subscription:session.subscription?.id;}
 else if(['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted'].includes(event.type)){subscriptionId=(event.data.object as Stripe.Subscription).id;}
 else if(['invoice.paid','invoice.payment_failed'].includes(event.type)){const invoice=event.data.object as Stripe.Invoice;const sub=invoice.parent?.subscription_details?.subscription;subscriptionId=typeof sub==='string'?sub:sub?.id;}
 if(!subscriptionId)return {received:true};
 // Fetch authoritative state, not stale event payloads; DB deduplicates + rejects older events.
 const subscription=await client.subscriptions.retrieve(subscriptionId);const userId=subscription.metadata.user_id;
 if(!userId||!/^[0-9a-f-]{36}$/i.test(userId))throw new AppError('Subscription owner not found',400);
 const item=subscription.items.data[0];if(subscription.items.data.length!==1||item.quantity!==1||item.price.currency!=='myr'||item.price.recurring?.interval!=='month'||item.price.recurring.interval_count!==1)throw new AppError('Unsupported subscription configuration',400);const configured=['starter','pro','business'].find(p=>process.env[`STRIPE_PRICE_${p.toUpperCase()}`]===item?.price.id);
 if(!configured)throw new AppError('Unknown subscription price',400);
 const result=await db().rpc('apply_subscription',{p_event_id:event.id,p_event_created:event.created,p_user:userId,p_plan:configured,p_status:subscription.status,p_start:new Date(item.current_period_start*1000).toISOString(),p_end:new Date(item.current_period_end*1000).toISOString(),p_customer:typeof subscription.customer==='string'?subscription.customer:subscription.customer.id,p_subscription:subscription.id,p_cancel:subscription.cancel_at_period_end,p_amount:(item.price.unit_amount||0)/100});checkDB(result.error);return {received:true};
}
